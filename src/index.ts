import he from 'he'
import TurndownService from 'turndown'
import { createDocument } from '@mixmark-io/domino'

import courses from '../courses.json'

const turndownService = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' })

// Piazza uses <pre> instead of <pre><code> for code blocks
turndownService.addRule('codeblock', {
  filter: 'pre',
  replacement: content => '```\n' + content + '\n```'
})

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
		if (postData.uid && postData.anon === 'no') {
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

		const header = `## ${title}\n${capitalize(post.type)} ${post.folders.length ? `in ${post.folders.join(', ')}` : ''}`

		const content = (
			postData.content.startsWith('<md>') && postData.content.endsWith('</md>')
				? postData.content.slice(4, -5)
				: turndownService.turndown(createDocument(postData.content))
		)
			.replace(/https?:\/\/[^\s"'<>]+/g, url => url.replaceAll('\\', ''))
			.replace(/\[(.+)\]\(\1\)/g, '$1')
			.replace(/!\[.*\]\(\/(.+)\)/g, '<__block_boundary>__image:https://piazza.com/$1<__block_boundary>')
			.replaceAll('](/', '](https://piazza.com/')

		// if the post contains images, send a components v2 message with media gallery components
		const components = []
		let isComponentsV2 = false
		if (content.includes('<__block_boundary>')) {
			isComponentsV2 = true
			components.push({
				type: 10,
				content: trim(header, 1000)
			})

			for (const block of content.split('<__block_boundary>').filter(part => part.trim())) {
				if (block.startsWith('__image:')) {
					components.push({
						type: 12,
						items: [
							{
								media: {
									url: block.slice(8),
								}
							}
						]
					})
				} else {
					components.push({
						type: 10,
						content: trim(block, 2000)
					})
				}
			}
		}

		const webhook = post.tags.includes('instructor-note') ? announcementWebhook : feedWebhook
		await fetch(webhook + '?with_components=true', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				username: `${user?.name ?? 'Anonymous'} on Piazza`,
				content: isComponentsV2 ? undefined : trim(`${header}\n\n${content}`, 2000),
				components: [
					...components,
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
				},
				flags: isComponentsV2 ? 1 << 15 : 0
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
