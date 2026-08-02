/**
 * Offline smoke test. Boots the real Express app in-process with dummy
 * credentials and checks the things that do not require calling xAI or
 * Supabase: auth rejection, protocol discovery, session handling, the tool
 * surface, and prompt assembly.
 *
 * Run with: npm run smoke
 */
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';

// Dummy config, set before any module reads it.
process.env.XAI_API_KEY ||= 'xai-smoketestkey0000000000';
process.env.SUPABASE_URL ||= 'https://smoke.supabase.co';
process.env.SUPABASE_SERVICE_KEY ||= 'smoke-service-key-0000';
process.env.SHORTS_SHARED_SECRET ||= 'smoke-shared-secret-0000';
process.env.LOG_LEVEL ||= 'error';

const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = await import(
    '@modelcontextprotocol/sdk/client/streamableHttp.js'
);
const { createApp } = await import('../src/server.js');
const { buildPrompt, STYLE_BLOCK, NEGATIVE_BLOCK, REFERENCE_BLOCK } = await import(
    '../src/config.js'
);
const { redact } = await import('../src/logger.js');

const SECRET = process.env.SHORTS_SHARED_SECRET!;
const results: string[] = [];

function pass(name: string): void {
    results.push(name);
    console.log(`  ok  ${name}`);
}

const server = createApp().listen(0);
await new Promise<void>((r) => server.once('listening', () => r()));
const { port } = server.address() as AddressInfo;
const base = `http://127.0.0.1:${port}/`;

try {
    // --- acceptance test 6: unauthenticated requests are rejected -----------
    {
        const res = await fetch(base, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
        });
        assert.equal(res.status, 401, `expected 401 without header, got ${res.status}`);
        pass('POST without shared secret → 401');
    }
    {
        const res = await fetch(base, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Api-Key': 'wrong-secret-value00' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
        });
        assert.equal(res.status, 401, `expected 401 with wrong secret, got ${res.status}`);
        pass('POST with wrong shared secret → 401');
    }

    // --- every header name claude.ai will actually forward -------------------
    for (const [name, value] of [
        ['X-Api-Key', SECRET],
        ['X-Auth-Token', SECRET],
        ['Authorization', `Bearer ${SECRET}`],
        // claude.ai sends the value verbatim, so a user who omits "Bearer "
        // must still get through rather than a confusing 401.
        ['Authorization', SECRET],
    ] as const) {
        const res = await fetch(base, { method: 'HEAD', headers: { [name]: value } });
        assert.equal(
            res.status,
            200,
            `expected 200 for ${name}${value === SECRET ? '' : ' (with scheme)'}, got ${res.status}`,
        );
    }
    pass('accepts all allowlisted header names (x-api-key, x-auth-token, authorization ±Bearer)');

    // --- secret-in-URL, the only option without the header beta --------------
    {
        const good = await fetch(`${base}${SECRET}`, { method: 'HEAD' });
        assert.equal(good.status, 200, `expected 200 for /<secret>, got ${good.status}`);

        const bad = await fetch(`${base}not-the-secret`, { method: 'HEAD' });
        assert.equal(bad.status, 401, `expected 401 for wrong path token, got ${bad.status}`);
        pass('secret-in-URL path authenticates, wrong token → 401');
    }

    // --- HEAD discovery at the root path -----------------------------------
    {
        const bad = await fetch(base, { method: 'HEAD' });
        assert.equal(bad.status, 401);
        const good = await fetch(base, { method: 'HEAD', headers: { 'X-Api-Key': SECRET } });
        assert.equal(good.status, 200, `expected HEAD 200, got ${good.status}`);
        pass('HEAD / supports protocol discovery and is gated');
    }

    // --- OAuth discovery must 404, never 401 --------------------------------
    // A 401 here makes Claude believe the server is OAuth-protected and send it
    // into a dynamic client registration it cannot complete.
    {
        for (const path of [
            '.well-known/oauth-protected-resource',
            '.well-known/oauth-authorization-server',
            '.well-known/openid-configuration',
            `.well-known/oauth-protected-resource/${SECRET}`,
        ]) {
            const res = await fetch(`${base}${path}`);
            assert.equal(res.status, 404, `${path} must 404 to disclaim OAuth, got ${res.status}`);
        }
        pass('OAuth discovery endpoints 404 (no accidental OAuth handshake)');
    }

    // --- health probe is open ----------------------------------------------
    {
        const res = await fetch(`http://127.0.0.1:${port}/healthz`);
        assert.equal(res.status, 200);
        pass('GET /healthz is unauthenticated');
    }

    // --- the studio: mount ordering is the fragile part ----------------------
    //
    // `/:token` matches any single path segment, so /studio and /api only work
    // because they are registered before it. Get that wrong and the studio
    // silently becomes a 401 from the MCP auth middleware.
    {
        const res = await fetch(`${base}studio`);
        const body = await res.text();
        assert.equal(res.status, 200, `expected the studio to be served, got ${res.status}`);
        assert.match(res.headers.get('content-type') ?? '', /text\/html/);
        assert.match(body, /<title>Shorts Studio<\/title>/);
        // The page must carry no data and no credential — it is served to
        // anyone who asks for it.
        assert.ok(!body.includes(SECRET), 'the studio document must not embed the shared secret');
        pass('GET /studio serves the studio shell, unauthenticated and dataless');
    }
    {
        const res = await fetch(`${base}api/config`);
        assert.equal(res.status, 401, `expected /api to be gated, got ${res.status}`);
        pass('/api is gated by the same shared secret');
    }
    {
        const res = await fetch(`${base}api/config`, { headers: { 'X-Api-Key': SECRET } });
        assert.equal(res.status, 200, `expected /api/config to answer, got ${res.status}`);
        const body = (await res.json()) as Record<string, unknown>;
        for (const key of ['video_model', 'image_model', 'vision_model', 'defaults']) {
            assert.ok(key in body, `/api/config is missing ${key}`);
        }
        // The config route describes the deployment; it must never hand back
        // anything that could be used to call xAI directly.
        assert.ok(
            !JSON.stringify(body).includes(process.env.XAI_API_KEY!),
            '/api/config leaked the xAI key',
        );
        pass('/api/config reports the running models without leaking credentials');
    }
    {
        const res = await fetch(`${base}api/assist`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Api-Key': SECRET },
            body: JSON.stringify({ mode: 'not-a-mode' }),
        });
        assert.equal(res.status, 400, `expected a 400 for a bad assist mode, got ${res.status}`);
        const body = (await res.json()) as { error?: string };
        assert.match(String(body.error), /Unknown assist mode/);
        pass('/api returns structured JSON errors, not stack traces');
    }

    // --- a stale session id is rejected, not silently accepted ---------------
    {
        const res = await fetch(base, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Api-Key': SECRET,
                'mcp-session-id': '00000000-0000-4000-8000-000000000000',
            },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
        });
        assert.equal(res.status, 404, `expected 404 for unknown session, got ${res.status}`);
        pass('unknown session id → 404 (client re-initializes)');
    }

    // --- full MCP handshake over Streamable HTTP ----------------------------
    {
        const client = new Client({ name: 'smoke', version: '1.0.0' });
        const transport = new StreamableHTTPClientTransport(new URL(base), {
            requestInit: { headers: { 'X-Api-Key': SECRET } },
        });
        await client.connect(transport);
        pass('Streamable HTTP initialize handshake at root path');

        const { tools } = await client.listTools();
        const names = tools.map((t) => t.name).sort();
        assert.deepEqual(names, [
            'animate',
            'approve_still',
            'check_job',
            'generate_still',
            'get_story_manifest',
            'import_image',
            'import_reference_image',
            'list_shots',
            'save_story_manifest',
        ]);
        pass(`tools/list returns the expected generation + import tools`);

        // No tool may expose a style parameter — style is server-owned.
        for (const tool of tools) {
            const props = Object.keys(
                (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {},
            );
            assert.ok(!props.includes('style'), `${tool.name} must not expose a style param`);
        }
        pass('no tool exposes a `style` parameter');

        const propsOf = (name: string): string[] =>
            Object.keys(
                (tools.find((t) => t.name === name)!.inputSchema as {
                    properties?: Record<string, unknown>;
                }).properties ?? {},
            );

        assert.ok(propsOf('animate').includes('motion_instruction'));
        assert.ok(propsOf('animate').includes('duration'));
        pass('animate exposes motion_instruction and duration');

        // Projects are addressable on both generated and imported stills.
        assert.ok(propsOf('generate_still').includes('project_name'));
        assert.ok(propsOf('import_image').includes('project_name'));
        assert.ok(propsOf('list_shots').includes('project_name'));
        pass('projects are addressable by name');

        assert.ok(propsOf('import_image').includes('image_url'));
        assert.ok(propsOf('import_image').includes('image_base64'));
        assert.ok(propsOf('import_image').includes('image_file'));
        assert.ok(propsOf('import_image').includes('shot_id'));
        pass('import_image accepts URL, base64, file-like image payloads and shot replacements');

        assert.ok(propsOf('import_reference_image').includes('role'));
        assert.ok(propsOf('import_reference_image').includes('label'));
        assert.ok(propsOf('import_reference_image').includes('image_url'));
        assert.ok(propsOf('save_story_manifest').includes('manifest'));
        assert.ok(propsOf('get_story_manifest').includes('role'));
        pass('story manifest and reference-image tools are exposed');

        // Token control for the embedded images.
        assert.ok(propsOf('generate_still').includes('include_images'));
        assert.ok(propsOf('check_job').includes('include_images'));
        assert.ok(propsOf('check_job').includes('include_frames'));
        pass('generate_still exposes include_images; check_job exposes video diagnostics');

        assert.ok(propsOf('generate_still').includes('reference_asset_ids'));
        pass('generate_still accepts reference images by asset id');

        // One image slot per call by default, not one per variation: hosts may
        // cap images per conversation, and four blocks per call burns it fast.
        assert.ok(propsOf('generate_still').includes('image_mode'));
        const modeSchema = (
            tools.find((t) => t.name === 'generate_still')!.inputSchema as any
        ).properties.image_mode;
        assert.deepEqual((modeSchema.enum ?? modeSchema.anyOf?.map((a: any) => a.const)).sort(), [
            'individual',
            'sheet',
        ]);
        pass('generate_still exposes image_mode (sheet | individual)');

        // Text reaches the model when image blocks do not, so the critique is
        // the fallback that keeps it able to judge rather than guess.
        assert.ok(propsOf('generate_still').includes('critique'));
        assert.ok(propsOf('check_job').includes('critique'));
        pass('generate_still and check_job expose the vision critique switch');

        // --- MCP Apps (SEP-1865) UI resources ---------------------------------
        const metaOf = (name: string): any => tools.find((t) => t.name === name)?._meta ?? {};
        assert.equal(metaOf('generate_still').ui?.resourceUri, 'ui://shorts/gallery.html');
        assert.equal(metaOf('check_job').ui?.resourceUri, 'ui://shorts/player.html');
        assert.equal(metaOf('import_image').ui?.resourceUri, undefined);
        assert.equal(metaOf('import_reference_image').ui?.resourceUri, undefined);
        assert.equal(metaOf('import_image')['ui/resourceUri'], undefined);
        assert.equal(metaOf('import_reference_image')['ui/resourceUri'], undefined);
        // animate too, so a job card appears at submission rather than only
        // once someone polls.
        assert.equal(metaOf('animate').ui?.resourceUri, 'ui://shorts/player.html');
        // The flat key is deprecated but still what some hosts read.
        assert.equal(metaOf('generate_still')['ui/resourceUri'], 'ui://shorts/gallery.html');
        pass('generate_still, animate and check_job reference UI resources; imports stay plain');

        const { resources } = await client.listResources();
        const uris = resources.map((r) => r.uri).sort();
        assert.deepEqual(uris, ['ui://shorts/gallery.html', 'ui://shorts/player.html']);
        assert.ok(
            resources.every((r) => r.mimeType === 'text/html;profile=mcp-app'),
            'UI resources must use the mcp-app profile MIME type',
        );
        pass('both UI resources are listed with the mcp-app MIME type');

        for (const uri of uris) {
            const read = await client.readResource({ uri });
            const item = read.contents[0] as { text?: string; mimeType?: string };
            assert.equal(item.mimeType, 'text/html;profile=mcp-app');
            assert.ok(item.text?.startsWith('<!doctype html>'), `${uri} must be a document`);
            assert.ok(item.text!.includes('<script>'), `${uri} must inline its script`);
            // A sandboxed iframe cannot fetch siblings, so nothing may be external.
            assert.ok(
                !/<script[^>]+src=/i.test(item.text!) && !/<link[^>]+stylesheet/i.test(item.text!),
                `${uri} must be fully self-contained`,
            );
        }
        pass('UI resources are self-contained documents with no external refs');

        // The gallery still paints embedded image bytes. The player is
        // intentionally video-first and does not display first/last-frame image
        // blocks in the normal path.
        {
            const gallery = await client.readResource({ uri: 'ui://shorts/gallery.html' });
            const galleryHtml = (gallery.contents[0] as { text?: string }).text ?? '';
            assert.ok(
                galleryHtml.includes('base64,') || galleryHtml.includes('base64ToBlob'),
                'gallery must be able to paint embedded image bytes',
            );

            const player = await client.readResource({ uri: 'ui://shorts/player.html' });
            const playerHtml = (player.contents[0] as { text?: string }).text ?? '';
            assert.ok(
                playerHtml.includes('include_images:!1') ||
                    playerHtml.includes('include_images:false'),
                'player polling must not request frame image blocks by default',
            );
        }
        pass('gallery paints images; player stays video-first');

        // Every referenced resource must actually exist: a tool pointing at a
        // missing ui:// is a broken card with no error anyone would see.
        for (const name of ['generate_still', 'animate', 'check_job']) {
            const uri = metaOf(name).ui?.resourceUri;
            assert.ok(uris.includes(uri), `${name} references unknown resource ${uri}`);
        }
        pass('every tool-referenced UI resource is actually served');

        // Sandbox CSP is deny-by-default: without this the widget renders fine
        // but every image and video inside it is blocked — a silent failure
        // that looks exactly like a broken image host.
        //
        // It must be present on BOTH the listing and the read result. The
        // listing copy is only a fallback; the content item carries the
        // authoritative value, and a host reading it there would otherwise find
        // nothing.
        for (const uri of uris) {
            const listed = resources.find((r) => r.uri === uri) as any;
            const listedCsp = listed?._meta?.ui?.csp?.resourceDomains;
            assert.ok(
                Array.isArray(listedCsp) && listedCsp.some((d: string) => d.includes('supabase')),
                `${uri} listing must allowlist the storage origin`,
            );

            const read = await client.readResource({ uri });
            const readCsp = (read.contents[0] as any)?._meta?.ui?.csp?.resourceDomains;
            assert.ok(
                Array.isArray(readCsp) && readCsp.some((d: string) => d.includes('supabase')),
                `${uri} read result must allowlist the storage origin, not just the listing`,
            );
        }
        pass('UI resources allowlist the Storage origin on both listing and read');

        await client.close();
    }

    // --- the same handshake over the secret-in-URL route --------------------
    // This is the route claude.ai actually uses, so a HEAD check is not enough:
    // the transport must survive being mounted under a path prefix, including
    // session id round-tripping.
    {
        const client = new Client({ name: 'smoke-url-auth', version: '1.0.0' });
        await client.connect(
            new StreamableHTTPClientTransport(new URL(`${base}${SECRET}`)),
        );
        const { tools } = await client.listTools();
        assert.equal(tools.length, 9, `expected 9 tools over URL auth, got ${tools.length}`);

        // Exercise a second round trip so session reuse under the prefix is
        // covered, not just initialize.
        const again = await client.listTools();
        assert.equal(again.tools.length, 9);

        await client.close();
        pass('full MCP handshake + session reuse over /<secret> (no headers at all)');
    }

    // --- ENABLE_MCP_APPS kill switch ---------------------------------------
    // Widgets are the prime suspect for image blocks going blank in some hosts,
    // so turning them off must remove BOTH halves: a tool still pointing at a
    // resource the server no longer serves is worse than no widget at all.
    {
        process.env.ENABLE_MCP_APPS = 'false';
        const { resetConfigCache } = await import('../src/config.js');
        resetConfigCache();

        const offServer = createApp().listen(0);
        await new Promise<void>((r) => offServer.once('listening', () => r()));
        const offPort = (offServer.address() as AddressInfo).port;

        const offClient = new Client({ name: 'smoke-apps-off', version: '1.0.0' });
        try {
            await offClient.connect(
                new StreamableHTTPClientTransport(
                    new URL(`http://127.0.0.1:${offPort}/${SECRET}`),
                ),
            );

            // With nothing registered the server does not advertise the
            // resources capability at all, so resources/list is -32601 rather
            // than an empty list. Either outcome means "no widgets".
            let offResourceCount = 0;
            try {
                offResourceCount = (await offClient.listResources()).resources.length;
            } catch (err) {
                assert.match(
                    err instanceof Error ? err.message : String(err),
                    /-32601|Method not found/,
                    'resources/list should be absent, not failing for another reason',
                );
            }
            assert.equal(offResourceCount, 0, 'no UI resources when disabled');

            const { tools: offTools } = await offClient.listTools();
            for (const name of ['generate_still', 'check_job']) {
                const meta = (offTools.find((t) => t.name === name)?._meta ?? {}) as any;
                assert.ok(!meta.ui?.resourceUri, `${name} must not reference a UI resource`);
                assert.ok(!meta['ui/resourceUri'], `${name} must not carry the flat key`);
            }
            assert.equal(offTools.length, 9, 'tools themselves are unaffected');
            pass('ENABLE_MCP_APPS=false removes both the resources and the tool _meta');
        } finally {
            await offClient.close().catch(() => {});
            offServer.close();
            process.env.ENABLE_MCP_APPS = 'true';
            resetConfigCache();
        }
    }

    // --- prompt assembly ----------------------------------------------------
    {
        const prompt = buildPrompt({
            shotDescription: 'A lone figure walks a rain-slick alley',
            motionInstruction: 'slow push in',
            paletteOverride: 'deep red palette',
        });
        assert.ok(prompt.includes(STYLE_BLOCK), 'style block must be present');
        assert.ok(prompt.includes(NEGATIVE_BLOCK), 'negative block must be present');
        assert.ok(
            prompt.indexOf('deep red palette') > prompt.indexOf(STYLE_BLOCK),
            'palette override must come after the style block',
        );
        assert.ok(
            prompt.indexOf('slow push in') < prompt.indexOf(STYLE_BLOCK),
            'motion instruction must come before the style block',
        );
        pass('prompt assembly: style + negative always applied, palette after style');

        const bare = buildPrompt({ shotDescription: 'A quiet room' });
        assert.ok(bare.includes(STYLE_BLOCK) && bare.includes(NEGATIVE_BLOCK));
        pass('prompt assembly: style applied even with no optional params');

        // The continuity instruction is server-owned too, and must appear only
        // when references are actually supplied.
        const withRef = buildPrompt({ shotDescription: 'A quiet room', hasReferences: true });
        assert.ok(withRef.includes(REFERENCE_BLOCK), 'reference block missing when referencing');
        assert.ok(!bare.includes(REFERENCE_BLOCK), 'reference block leaked without references');
        assert.ok(
            withRef.indexOf(REFERENCE_BLOCK) < withRef.indexOf(NEGATIVE_BLOCK),
            'reference block must precede the negative block',
        );
        pass('prompt assembly: reference block added only when references are passed');
    }

    // --- acceptance test 8: the key never survives redaction -----------------
    {
        const leaky = `call failed: Authorization: Bearer ${process.env.XAI_API_KEY} rejected`;
        const cleaned = redact(leaky);
        assert.ok(!cleaned.includes(process.env.XAI_API_KEY!), 'xAI key leaked through redact()');
        assert.ok(cleaned.includes('[redacted]'));
        pass('redact() strips the xAI key from error text');
    }

    console.log(`\n${results.length} checks passed.`);
} catch (err) {
    console.error('\nSMOKE TEST FAILED:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
} finally {
    server.close();
}
