import {
    registerAppResource,
    RESOURCE_MIME_TYPE,
} from '@modelcontextprotocol/ext-apps/server';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getConfig } from './config.js';
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
 * user, the image blocks are for the model. Neither replaces the other.
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
    const csp = { resourceDomains: resourceDomains() };

    registerAppResource(
        server,
        'shorts-gallery',
        GALLERY_URI,
        {
            title: 'Still variations',
            description:
                'Gallery of generated still variations. Click one to approve it.',
            mimeType: RESOURCE_MIME_TYPE,
            _meta: { ui: { csp, prefersBorder: false } },
        },
        async () => ({
            contents: [
                { uri: GALLERY_URI, mimeType: RESOURCE_MIME_TYPE, text: GALLERY_HTML },
            ],
        }),
    );

    registerAppResource(
        server,
        'shorts-player',
        PLAYER_URI,
        {
            title: 'Clip player',
            description:
                'Plays the finished clip and shows its first and last frame side by side.',
            mimeType: RESOURCE_MIME_TYPE,
            _meta: { ui: { csp, prefersBorder: false } },
        },
        async () => ({
            contents: [
                { uri: PLAYER_URI, mimeType: RESOURCE_MIME_TYPE, text: PLAYER_HTML },
            ],
        }),
    );
}

/**
 * Tool `_meta` pointing at a UI resource.
 *
 * Both the nested and flat keys are emitted: the flat `ui/resourceUri` is
 * deprecated but still what some hosts read, and the SDK's own helper writes
 * both for exactly that reason.
 */
export function uiMeta(resourceUri: string): Record<string, unknown> {
    return {
        ui: { resourceUri },
        'ui/resourceUri': resourceUri,
    };
}
