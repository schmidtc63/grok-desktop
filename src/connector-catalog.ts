export type ConnectorCatalogEntry = {
	id: string;
	name: string;
	vendor: string;
	description: string;
	source: string;
	transport: "stdio" | "http" | "sse";
	target: string;
	extra: string;
	note: string;
};

const oauthNote = "Uses OAuth. Complete sign-in in Grok's interactive /mcps menu outside this app before use.";

export const connectorCatalog: ConnectorCatalogEntry[] = [
	{
		id: "github",
		name: "GitHub",
		vendor: "GitHub",
		description: "Work with repositories, issues, pull requests and GitHub Actions.",
		source: "https://github.com/github/github-mcp-server",
		transport: "http",
		target: "https://api.githubcopilot.com/mcp/",
		extra: "Authorization: Bearer ${GITHUB_TOKEN}",
		note: "Set GITHUB_TOKEN in your environment to a GitHub personal access token with the permissions you need.",
	},
	{
		id: "playwright",
		name: "Playwright",
		vendor: "Microsoft",
		description: "Automate a browser using Playwright's page snapshots and browser tools.",
		source: "https://github.com/microsoft/playwright-mcp",
		transport: "stdio",
		target: "npx -y @playwright/mcp@latest",
		extra: "",
		note: "Requires Node.js 18 or newer. Grok launches this local server when it connects.",
	},
	{
		id: "sentry",
		name: "Sentry",
		vendor: "Sentry",
		description: "Find and investigate application errors, performance and Sentry issues.",
		source: "https://mcp.sentry.dev/",
		transport: "http",
		target: "https://mcp.sentry.dev/mcp",
		extra: "",
		note: oauthNote,
	},
	{
		id: "linear",
		name: "Linear",
		vendor: "Linear",
		description: "Find and manage issues, projects and comments in Linear.",
		source: "https://linear.app/docs/mcp",
		transport: "http",
		target: "https://mcp.linear.app/mcp",
		extra: "",
		note: oauthNote,
	},
	{
		id: "notion",
		name: "Notion",
		vendor: "Notion",
		description: "Search your workspace and work with Notion pages and databases.",
		source: "https://developers.notion.com/guides/mcp/get-started-with-mcp",
		transport: "http",
		target: "https://mcp.notion.com/mcp",
		extra: "",
		note: oauthNote,
	},
	{
		id: "atlassian",
		name: "Atlassian",
		vendor: "Atlassian",
		description: "Search and work with Jira, Confluence and other permitted Atlassian apps.",
		source: "https://support.atlassian.com/atlassian-ai-gateway/docs/configure-oauth-2-1/",
		transport: "http",
		target: "https://mcp.atlassian.com/v2/mcp",
		extra: "",
		note: oauthNote,
	},
	{
		id: "stripe",
		name: "Stripe",
		vendor: "Stripe",
		description: "Use the Stripe API and search Stripe documentation and support guidance.",
		source: "https://docs.stripe.com/mcp",
		transport: "http",
		target: "https://mcp.stripe.com",
		extra: "",
		note: oauthNote,
	},
	{
		id: "cloudflare",
		name: "Cloudflare",
		vendor: "Cloudflare",
		description: "Find Cloudflare documentation and work with Cloudflare API services.",
		source: "https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/",
		transport: "http",
		target: "https://mcp.cloudflare.com/mcp",
		extra: "",
		note: oauthNote,
	},
];
