import {
    registerAppResource,
    RESOURCE_MIME_TYPE,
} from '@modelcontextprotocol/ext-apps/server';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getConfig } from './config.js';
import { log } from './logger.js';
import { GALLERY_HTML, PLAYER_HTML } from './widgets.generated.js';

/**
 * MCP Apps (SEP-1865) UI resources.
 *
 * Image content blocks go to the model; they do not put anything on the chat
 * surface for the human. A UI resource does the opposite — the host renders it
 * in a sandboxed iframe inline in the conversation, so the person driving the
 * pipeline can actually see the four variations and watch the clip.
 *
 * The two mechanisms are complementary and both are kept: the widget is for the
 * user, the image blocks are for the model when explicitly requested. Neither
 * replaces the other.
 *
 * This is an optional, backwards-compatible extension. Hosts that do not
 * support it ignore the `_meta` and the resource, and still get the text and
 * image content exactly as before, so nothing is gated on capability
 * negotiation.
 */

export const GALLERY_URI = 'ui://shorts/gallery.html';
export const PLAYER_URI = 'ui://shorts/player.html';

/**
 * Sandbox CSP is deny-by-default: with no `resourceDomains` the iframe may load
 * no images, video, or fonts at all. The widgets are nothing but media from our
 * own Storage bucket, so the bucket origin has to be declared explicitly or
 * they render empty.
 */
function resourceDomains(): string[] {
    const { supabaseUrl } = getConfig();
    try {
        return [new URL(supabaseUrl).origin];
    } catch {
        return [supabaseUrl];
    }
}

export function registerApps(server: McpServer): void {
    if (!getConfig().enableMcpApps) {
        log.info('mcp apps disabled by ENABLE_MCP_APPS');
        return;
    }
    const csp = { resourceDomains: resourceDomains() };
    const uiMetaForResource = { ui: { csp, prefersBorder: false } };

    /**
     * The same UI metadata has to go in two places.
     *
     * On the resource listing it is only a *fallback*; the content item
     * returned by `resources/read` carries the authoritative value. Declaring
     * it on the listing alone means a host that reads CSP from the read result
     * finds none — and sandbox CSP is deny-by-default, so every image and video
     * in the widget is blocked while the widget itself renders perfectly. The
     * failure is silent and looks exactly like a broken image host.
     */
    const register = (
        name: string,
        uri: string,
        title: string,
        description: string,
        html: string,
    ): void => {
        registerAppResource(
            server,
            name,
            uri,
            { title, description, mimeType: RESOURCE_MIME_TYPE, _meta: uiMetaForResource },
            async () => ({
                contents: [
                    {
                        uri,
                        mimeType: RESOURCE_MIME_TYPE,
                        text: html,
                        _meta: uiMetaForResource,
                    },
                ],
            }),
        );
    };

    register(
        'shorts-gallery',
        GALLERY_URI,
        'Still variations',
        'Gallery of generated still variations. Click one to approve it.',
        GALLERY_HTML,
    );

    register(
        'shorts-player',
        PLAYER_URI,
        'Clip player',
        'Live job card, then the finished clip.',
        PLAYER_HTML,
    );
}

/**
 * Tool `_meta` pointing at a UI resource.
 *
 * Both the nested and flat keys are emitted: the flat `ui/resourceUri` is
 * deprecated but still what some hosts read, and the SDK's own helper writes
 * both for exactly that reason.
 */
export function uiMeta(resourceUri: string): Record<string, unknown> | undefined {
    // Must honour the same switch as registerApps: a tool pointing at a
    // resource the server no longer serves is worse than no widget at all.
    if (!getConfig().enableMcpApps) return undefined;
    return {
        ui: { resourceUri },
        'ui/resourceUri': resourceUri,
    };
}
