declare module '@mixmark-io/domino' {
  export function createDocument(html: string): Document
}

interface Env {
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
			anon?: string
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
