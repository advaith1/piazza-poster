export interface Env {
	PIAZZA_EMAIL: string
	PIAZZA_PASSWORD: string

	LAST_POSTS: KVNamespace
}

interface PiazzaFeedResponse {
	result: {
		feed: {
			nr: number
			type: 'note' | 'question'
			subject: string
			content_snipet: string
			folders: string[]
			tags: string[]
			status: string
		}[]
	}
}

interface PiazzaPostResponse {
	result: {
		history: {
			uid?: string
			subject: string
			content: string
		}[]
	}
}

interface User {
	name: string
}

interface PiazzaUserResponse {
	result: User[]
}

interface Course {
	courseID: string
	piazzaID: string
	announcementWebhook: string
	feedWebhook: string
}

import he from 'he'

import courses from '../courses.json'

const capitalize = (str: string) => str[0].toUpperCase() + str.slice(1)

const trim = (text: string, max: number) => text.length > max ? text.substring(0, max - 1)+'…' : text

const checkCourse = async ({ courseID, piazzaID, announcementWebhook, feedWebhook }: Course, cookie: string, csrfToken: string, env: Env) => {
	const { result: { feed } } = await (await fetch('https://piazza.com/logic/api?method=network.get_my_feed', {
		method: 'POST',
		headers: {
			cookie,
			'csrf-token': csrfToken,
			'content-type': 'application/json',
		},
		body: JSON.stringify({
			method: 'network.get_my_feed',
			params: {
				nid: piazzaID,
				offset: 0,
				limit: 200
			}
		})
	})).json() as PiazzaFeedResponse

	const lastPostNumber = +(await env.LAST_POSTS.get(courseID) ?? 0)

	const newPosts = feed.filter(post => post.nr > lastPostNumber && post.status !== 'private')
	if (!newPosts.length) return new Response('')

	await env.LAST_POSTS.put(courseID, Math.max(...feed.map(post => post.nr)).toString())

	newPosts.sort((a, b) => a.nr - b.nr)

	for (const post of newPosts) {
		const { result: { history: [postData] } } = await (await fetch('https://piazza.com/logic/api?method=content.get', {
			method: 'POST',
			headers: {
				cookie,
				'csrf-token': csrfToken,
				'content-type': 'application/json',
			},
			body: JSON.stringify({
				method: 'content.get',
				params: {
					cid: post.nr,
					nid: piazzaID
				}
			})
		})).json() as PiazzaPostResponse

		let user: User | undefined
		if (postData.uid) {
			const { result: [userData] } = await (await fetch('https://piazza.com/logic/api?method=network.get_users', {
				method: 'POST',
				headers: {
					cookie,
					'csrf-token': csrfToken,
					'content-type': 'application/json',
				},
				body: JSON.stringify({
					method: 'network.get_users',
					params: {
						ids: [postData.uid],
						nid: piazzaID
					}
				})
			})).json() as PiazzaUserResponse
			user = userData
		}

		const title = he.decode(postData.subject)

		const content = (await (await fetch('https://turndown.advaith.io', {
			method: 'POST',
			body: postData.content
		})).text()).replace(/https?:\/\/[^\s"'<>]+/g, url => url.replaceAll('\\', '')).replace(/\[(.+?)\]\(\1\)/g, '$1').replace(/!\[.*?\]\(\//g, '[[image]](https://piazza.com/').replaceAll('](/', '](https://piazza.com/')

		const webhook = post.tags.includes('instructor-note') ? announcementWebhook : feedWebhook
		await fetch(webhook + '?with_components=true', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				username: `${user?.name ?? 'Anonymous'} on Piazza`,
				content: trim(`## ${title}\n${capitalize(post.type)} ${post.folders.length ? `in ${post.folders.join(', ')}` : ''}\n\n${content}`, 2000),
				components: [
					{
						type: 1,
						components: [
							{
								type: 2,
								label: 'View on Piazza',
								style: 5,
								url: `https://piazza.com/class/${piazzaID}/post/${post.nr}`
							}
						]
					}
				],
				allowed_mentions: {
					parse: []
				}
			})
		})
	}
}

const getCookies = (res: Response) => res.headers.getSetCookie().map(cookie => cookie.split(';')[0]).join('; ')

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		return new Response('ok')
	},
	async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
		const csrfRes = await fetch('https://piazza.com/main/csrf_token')
		const csrfToken = (await csrfRes.text()).split('"')[1]

		const loginBody = new FormData()
		loginBody.append('from', '/signup')
		loginBody.append('email', env.PIAZZA_EMAIL)
		loginBody.append('password', env.PIAZZA_PASSWORD)
		loginBody.append('remember', 'on')
		loginBody.append('csrf_token', csrfToken)
		const loginRes = await fetch('https://piazza.com/class', {
			method: 'POST',
			headers: {
				cookie: getCookies(csrfRes)
			},
			body: loginBody
		})
		const cookie = getCookies(loginRes)

		for (const course of courses) {
			await checkCourse(course, cookie, csrfToken, env)
		}
	}
}
