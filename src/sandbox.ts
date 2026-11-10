import { PLATFORM } from "./data";
import type { AppSettings } from "./Settings";

interface SandboxedSession {
	environment: string;
	sandbox?: GrokSandboxChoice;
	sandboxOn?: boolean;
	sandboxChoice?: GrokSandboxChoice;
	agentSessionId?: string;
}

// The sandbox the settings describe, which on Windows is the last one chosen. The Sandbox panel tests and signs in with it.
export function configuredSandbox(settings: AppSettings, platform: string = PLATFORM): GrokSandboxChoice {
	if (platform !== "win32") { return { option: "profile", profile: settings.sandboxProfile }; }
	if (settings.sandboxOption === "docker") { return { option: "docker", ...(settings.sandboxDockerImage ? { image: settings.sandboxDockerImage } : {}) }; }
	if (settings.sandboxOption === "wsl") { return { option: "wsl", profile: settings.sandboxProfile, distro: settings.sandboxWslDistro }; }
	return { option: "windows-sandbox", mappedFolders: settings.sandboxMappedFolders };
}

// The session's Sandbox checkbox. A session saved before it was changed goes by how Grok started.
export function sandboxWanted(session: SandboxedSession) {
	return session.environment === "Local" && (session.sandboxOn ?? !!session.sandbox);
}

// Grok can't change a session's sandbox, so a change waits for the next message, which starts a new Grok session.
export function sandboxChanging(session: SandboxedSession) {
	if (!session.agentSessionId) { return false; }
	const wanted = sandboxWanted(session);
	return wanted !== !!session.sandbox || (wanted && !!session.sandboxChoice && JSON.stringify(session.sandboxChoice) !== JSON.stringify(session.sandbox));
}

export function sandboxProfileChanging(session: SandboxedSession, settings: Pick<AppSettings, "sandboxProfile">) {
	return PLATFORM !== "win32" && !!session.agentSessionId && sandboxWanted(session)
		&& session.sandbox?.option === "profile" && (session.sandbox.profile ?? "workspace") !== settings.sandboxProfile;
}

// Windows sessions keep their own choice. On macOS and Linux the profile comes from Settings.
export function sandboxFor(session: SandboxedSession, settings: AppSettings, platform: string = PLATFORM): GrokSandboxChoice | undefined {
	if (!sandboxWanted(session)) { return undefined; }
	if (platform === "win32") { return session.sandboxChoice ?? session.sandbox ?? configuredSandbox(settings, platform); }
	return configuredSandbox(settings, platform);
}

// Whether Grok is sandboxed right now, or will be when this session's first message starts it.
export function sandboxActive(session: SandboxedSession) {
	return sandboxChanging(session) ? !!session.sandbox : sandboxWanted(session);
}

const OPTION_NAMES: Record<GrokSandboxChoice["option"], string> = { profile: "Grok's sandbox", docker: "Docker", wsl: "WSL", "windows-sandbox": "Windows Sandbox" };

export function sandboxLabel(choice: GrokSandboxChoice) {
	return `Sandboxed: ${OPTION_NAMES[choice.option]}${choice.profile === "strict" ? ", strict" : ""}`;
}

// The Sandbox checkbox's text. On Windows a session can use any of three, so it names the one.
export function sandboxChipLabel(session: SandboxedSession, settings: AppSettings, platform: string = PLATFORM) {
	const choice = platform === "win32" ? sandboxFor(session, settings, platform) : undefined;
	return choice ? `Sandbox · ${OPTION_NAMES[choice.option]}` : "Sandbox";
}

// The session's line in the side panel. "" means there is nothing to say.
export function sandboxStatus(session: SandboxedSession, settings?: Pick<AppSettings, "sandboxProfile">) {
	if (session.sandbox && settings && sandboxProfileChanging(session, settings)) {
		return `${sandboxLabel(session.sandbox)}. Main chat changes to ${settings.sandboxProfile === "strict" ? "Strict" : "Workspace"} on next use`;
	}
	if (sandboxChanging(session)) {
		const wanted = sandboxWanted(session);
		if (wanted && session.sandbox && session.sandboxChoice) { return `Sandbox changes to ${OPTION_NAMES[session.sandboxChoice.option]} with your next message`; }
		return `Sandbox turns ${wanted ? "on" : "off"} with your next message`;
	}
	return session.sandbox ? sandboxLabel(session.sandbox) : "";
}
