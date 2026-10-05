/** Never forward RPC capabilities, arguments, or authentication through a redirect. */
export const withoutRedirects = Object.assign((input: RequestInfo | URL, init?: RequestInit) => fetch(input, { ...init, redirect: 'error' }), globalThis.fetch)
