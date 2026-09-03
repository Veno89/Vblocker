'use strict';

const fs = require('fs');
const vm = require('vm');
const assert = require('assert/strict');

const path = require('path');
const resourcePath = path.join(__dirname, '..', 'veno-twitch-stable.js');
let source = fs.readFileSync(resourcePath, 'utf8');
const firstNewline = source.indexOf('\n');
assert.match(source.slice(0, firstNewline), /^veno-twitch-stable\.js text\/javascript$/);
source = source.slice(firstNewline + 1);
const endMarker = source.lastIndexOf('})();');
assert.ok(endMarker > 0, 'IIFE end marker found');
source = source.slice(0, endMarker) + `
    window.__tasTest = {
        hookWorkerFetch,
        processM3U8,
        createStreamInfo,
        handleWorkerFetchRequest,
        getPlayerVideoElement,
        playerBufferState,
        get StreamInfos() { return StreamInfos; },
        get StreamInfosByUrl() { return StreamInfosByUrl; },
        get ForceAccessTokenPlayerType() { return ForceAccessTokenPlayerType; }
    };
` + source.slice(endMarker);

function makeResponse(body, { status = 200, headers = {}, url = '' } = {}) {
    const response = new Response(body, { status, headers });
    try { Object.defineProperty(response, 'url', { value: url, configurable: true }); } catch {}
    return response;
}

function createBrowserContext({
    hostname = 'www.twitch.tv',
    pathname = '/testchannel',
    search = '',
    baseFetch,
    videos = [],
    playerRoot = null,
    existingTasVersion,
} = {}) {
    const calls = [];
    const logs = [];
    const fetchImpl = baseFetch || (async (input, init) => {
        const url = typeof input === 'string' ? input : input?.url || String(input);
        calls.push({ url, init });
        return makeResponse('{}', { url });
    });

    class BrowserURL extends URL {}
    BrowserURL.createObjectURL = () => 'blob:https://www.twitch.tv/mock-worker';
    BrowserURL.revokeObjectURL = function() {};

    class MockWorker {
        constructor(url, options) {
            this.url = url;
            this.options = options;
            this.listeners = Object.create(null);
        }
        addEventListener(type, callback) {
            (this.listeners[type] ||= []).push(callback);
        }
        postMessage() {}
    }

    class MockXMLHttpRequest {
        constructor() {
            this.responseText = '';
        }
        open() {}
        overrideMimeType() {}
        send() {}
    }

    const storage = new Map();
    const localStorage = {
        getItem(key) { return storage.has(String(key)) ? storage.get(String(key)) : null; },
        setItem(key, value) { storage.set(String(key), String(value)); },
        removeItem(key) { storage.delete(String(key)); },
    };

    const listeners = Object.create(null);
    const document = {
        location: {
            hostname,
            pathname,
            search,
            href: `https://${hostname}${pathname}${search}`,
        },
        readyState: 'complete',
        hidden: false,
        pictureInPictureElement: null,
        head: { appendChild() {} },
        documentElement: { appendChild() {} },
        addEventListener(type, callback) { (listeners[type] ||= []).push(callback); },
        removeEventListener() {},
        getElementById() { return null; },
        querySelector(selector) {
            if (selector === '.video-player') return playerRoot;
            return null;
        },
        getElementsByTagName(tag) { return tag === 'video' ? videos : []; },
        createElement() {
            return {
                className: '',
                innerHTML: '',
                style: { display: '', setProperty() {}, removeProperty() {} },
                querySelector() { return { textContent: '' }; },
                appendChild() {},
            };
        },
    };

    const sandbox = {
        console: {
            log: (...args) => logs.push(args.join(' ')),
            error: (...args) => logs.push(args.join(' ')),
            warn: (...args) => logs.push(args.join(' ')),
        },
        document,
        navigator: { platform: 'Linux x86_64', maxTouchPoints: 0 },
        localStorage,
        Worker: MockWorker,
        XMLHttpRequest: MockXMLHttpRequest,
        fetch: async (input, init) => fetchImpl(input, init),
        postMessage() {},
        addEventListener() {},
        removeEventListener() {},
        frameElement: null,
        URL: BrowserURL,
        URLSearchParams,
        Request,
        Response,
        Headers,
        Blob,
        AbortController,
        Uint8Array,
        Map,
        Set,
        WeakMap,
        Object,
        Array,
        JSON,
        Math,
        Date,
        RegExp,
        String,
        Number,
        Boolean,
        Error,
        TypeError,
        Promise,
        parseInt,
        parseFloat,
        isNaN,
        atob: (text) => Buffer.from(text, 'base64').toString('binary'),
        btoa: (text) => Buffer.from(text, 'binary').toString('base64'),
        setTimeout: () => 1,
        clearTimeout: () => {},
        setInterval: () => 1,
        clearInterval: () => {},
    };
    if (existingTasVersion !== undefined) {
        sandbox.twitchAdSolutionsVersion = existingTasVersion;
    }
    sandbox.window = sandbox;
    sandbox.self = sandbox;
    const context = vm.createContext(sandbox);
    vm.runInContext(source, context, { filename: 'veno-twitch-stable.js', timeout: 5000 });
    return { context, calls, logs, listeners, storage };
}

async function testRouteGuards() {
    const vod = createBrowserContext({ pathname: '/videos/123456' });
    assert.equal(vod.context.venoTwitchStabilityVersion, undefined, 'VOD route untouched');

    const vodEmbed = createBrowserContext({ hostname: 'player.twitch.tv', pathname: '/', search: '?video=v123' });
    assert.equal(vodEmbed.context.venoTwitchStabilityVersion, undefined, 'VOD embed untouched');

    const chat = createBrowserContext({ pathname: '/popout/testchannel/chat' });
    assert.equal(chat.context.venoTwitchStabilityVersion, undefined, 'chat-only route untouched');

    const live = createBrowserContext({ pathname: '/testchannel' });
    assert.equal(live.context.venoTwitchStabilityVersion, '1.0.1', 'live route initialized');
    assert.ok(live.context.__tasTest, 'test exports attached on live route');

    const duplicate = createBrowserContext({ pathname: '/testchannel', existingTasVersion: 93 });
    assert.equal(duplicate.context.venoTwitchStabilityVersion, undefined, 'existing VAFT instance is not layered over');
    assert.equal(duplicate.context.twitchAdSolutionsVersion, 93, 'existing VAFT marker is preserved');
    assert.ok(duplicate.logs.some(line => line.includes('another TwitchAdSolutions resource is already active')),
        'duplicate guard explains why initialization was skipped');
}

async function testGraphqlScoping() {
    const calls = [];
    const { context } = createBrowserContext({
        baseFetch: async (input, init) => {
            const url = typeof input === 'string' ? input : input?.url || String(input);
            calls.push({ url, init });
            return makeResponse('{}', { url });
        },
    });

    const commonHeaders = new Headers({
        'X-Device-Id': 'device-1',
        'Authorization': 'OAuth test',
        'Client-Version': '1.2.3',
    });

    const livePacket = {
        operationName: 'PlaybackAccessToken',
        variables: { isLive: true, isVod: false, vodID: '', playerType: 'site' },
    };
    await context.fetch('https://gql.twitch.tv/gql', {
        method: 'POST', headers: commonHeaders, body: JSON.stringify(livePacket),
    });
    assert.equal(JSON.parse(calls.at(-1).init.body).variables.playerType, 'popout', 'live player type rewritten');

    await context.fetch(new context.URL('https://gql.twitch.tv/gql'), {
        method: 'POST', headers: commonHeaders, body: JSON.stringify(livePacket),
    });
    assert.equal(JSON.parse(calls.at(-1).init.body).variables.playerType, 'popout', 'URL-object GQL request rewritten');

    const vodPacket = {
        operationName: 'PlaybackAccessToken',
        variables: { isLive: false, isVod: true, vodID: '123', playerType: 'site' },
    };
    await context.fetch('https://gql.twitch.tv/gql', {
        method: 'POST', headers: commonHeaders, body: JSON.stringify(vodPacket),
    });
    assert.deepEqual(JSON.parse(calls.at(-1).init.body), vodPacket, 'VOD token untouched');

    const pipPacket = {
        operationName: 'PlaybackAccessToken',
        variables: { isLive: true, isVod: false, vodID: '', playerType: 'picture-by-picture' },
    };
    await context.fetch('https://gql.twitch.tv/gql', {
        method: 'POST', headers: commonHeaders, body: JSON.stringify(pipPacket),
    });
    assert.deepEqual(JSON.parse(calls.at(-1).init.body), pipPacket, 'PiP/chat token untouched');

    const batch = [
        { operationName: 'PlaybackAccessToken', variables: { isLive: true, isVod: false, vodID: '', playerType: 'site' } },
        { operationName: 'PlaybackAccessToken', variables: { isLive: false, isVod: true, vodID: '9', playerType: 'site' } },
        { operationName: 'UnrelatedOperation', variables: { playerType: 'site' } },
    ];
    await context.fetch('https://gql.twitch.tv/gql', {
        method: 'POST', headers: commonHeaders, body: JSON.stringify(batch),
    });
    const rewrittenBatch = JSON.parse(calls.at(-1).init.body);
    assert.equal(rewrittenBatch[0].variables.playerType, 'popout');
    assert.equal(rewrittenBatch[1].variables.playerType, 'site');
    assert.equal(rewrittenBatch[2].variables.playerType, 'site');

    await context.fetch('https://gql.twitch.tv/gql', { method: 'POST', headers: commonHeaders, body: '{bad json' });
    assert.equal(calls.at(-1).init.body, '{bad json', 'malformed GQL body fails open');

    await context.fetch('https://example.test/path?gql=true', {
        method: 'POST', headers: commonHeaders, body: JSON.stringify(livePacket),
    });
    assert.equal(JSON.parse(calls.at(-1).init.body).variables.playerType, 'site', 'lookalike URL untouched');

    await context.fetch('https://gql.twitch.tv/gql');
    assert.equal(calls.at(-1).init, undefined, 'missing init accepted');
}

async function testWorkerBridgeRestriction() {
    const calls = [];
    const { context } = createBrowserContext({
        baseFetch: async (input, init) => {
            const url = typeof input === 'string' ? input : input?.url || String(input);
            calls.push({ url, init });
            return makeResponse('{"ok":true}', { url, headers: { 'x-test': 'yes' } });
        },
    });

    const blockedTarget = await context.__tasTest.handleWorkerFetchRequest({
        id: 'a', url: 'https://evil.example/gql', options: { method: 'POST', body: '{}' },
    });
    assert.match(blockedTarget.error, /blocked a non-Twitch-GQL request/);

    const blockedOperation = await context.__tasTest.handleWorkerFetchRequest({
        id: 'b', url: 'https://gql.twitch.tv/gql',
        options: { method: 'POST', body: JSON.stringify({ operationName: 'DeleteEverything' }) },
    });
    assert.match(blockedOperation.error, /unexpected GQL operation/);

    const blockedLookalike = await context.__tasTest.handleWorkerFetchRequest({
        id: 'b2', url: 'https://gql.twitch.tv/gql',
        options: { method: 'POST', body: JSON.stringify({ operationName: 'EvilPlaybackAccessTokenLookalike' }) },
    });
    assert.match(blockedLookalike.error, /unexpected GQL operation/);

    const allowed = await context.__tasTest.handleWorkerFetchRequest({
        id: 'c', url: 'https://gql.twitch.tv/gql',
        options: {
            method: 'POST',
            body: JSON.stringify({ operationName: 'PlaybackAccessToken', variables: { isLive: true } }),
            headers: { 'Client-ID': 'client', Authorization: 'OAuth test', 'X-Evil': 'drop-me' },
        },
    });
    assert.equal(allowed.status, 200);
    assert.equal(calls.at(-1).url, 'https://gql.twitch.tv/gql');
    const forwardedHeaders = new Headers(calls.at(-1).init.headers);
    assert.equal(forwardedHeaders.get('client-id'), 'client');
    assert.equal(forwardedHeaders.get('authorization'), 'OAuth test');
    assert.equal(forwardedHeaders.get('x-evil'), null, 'unexpected header removed');
}

async function testHlsV2AndFailOpen() {
    const calls = [];
    const masterUrl = 'https://usher.ttvnw.net/api/v2/channel/hls/testchannel.m3u8?sig=x&token=y&parent_domains=www.twitch.tv';
    const rawVariantUrl = 'https://video-edge.example.net/v1/segment-path/chunked/index';
    const queryVariantUrl = 'https://video-edge.example.net/live/720p.m3u8?token=abc';
    const failOpenUrl = 'https://video-edge.example.net/live/fail-open.m3u8?token=abc';
    const masterText = [
        '#EXTM3U',
        '#EXT-X-SESSION-DATA:DATA-ID="SERVER-TIME",VALUE="1000"',
        '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1280x720,FRAME-RATE=60,CODECS="avc1.4d401f,mp4a.40.2"',
        rawVariantUrl,
        '',
    ].join('\n');
    const cleanMediaText = [
        '#EXTM3U',
        '#EXT-X-MEDIA-SEQUENCE:42',
        '#EXTINF:2.0,live',
        'https://cdn.example.net/live-42.ts',
        '',
    ].join('\n');

    const { context, logs } = createBrowserContext({
        baseFetch: async (input, init) => {
            const url = typeof input === 'string' ? input : input?.url || String(input);
            calls.push({ url, init });
            if (url.startsWith('https://usher.ttvnw.net/api/v2/channel/hls/testchannel.m3u8')) {
                return makeResponse(masterText, {
                    url,
                    headers: {
                        'content-type': 'application/vnd.apple.mpegurl',
                        'content-length': '99999',
                        'content-encoding': 'gzip',
                        'x-preserved': 'yes',
                    },
                });
            }
            if (url === rawVariantUrl || url === queryVariantUrl || url === failOpenUrl) {
                return makeResponse(cleanMediaText, {
                    url,
                    headers: {
                        'content-type': 'application/vnd.apple.mpegurl',
                        'content-length': '99999',
                        'content-encoding': 'gzip',
                        'x-preserved': 'yes',
                    },
                });
            }
            return makeResponse('{}', { url });
        },
    });

    context.__tasTest.hookWorkerFetch();

    const masterResponse = await Promise.race([
        context.fetch(masterUrl),
        new Promise((_, reject) => setTimeout(() => reject(new Error('master fetch hung')), 1000)),
    ]);
    assert.equal(masterResponse.status, 200);
    assert.equal(masterResponse.headers.get('content-length'), null, 'modified response removes stale length');
    assert.equal(masterResponse.headers.get('content-encoding'), null, 'modified response removes stale encoding');
    assert.equal(masterResponse.headers.get('x-preserved'), 'yes', 'unrelated header preserved');
    assert.match(await masterResponse.text(), /SERVER-TIME/);
    assert.ok(context.__tasTest.StreamInfosByUrl[rawVariantUrl], 'raw v2 variant mapped');

    const rawResponse = await Promise.race([
        context.fetch(rawVariantUrl),
        new Promise((_, reject) => setTimeout(() => reject(new Error('raw V2 media fetch hung')), 1000)),
    ]);
    assert.equal(await rawResponse.text(), cleanMediaText, 'raw V2 media playlist processed');

    // Query-string .m3u8 URLs must be recognized even when not mapped yet.
    const queryResponse = await Promise.race([
        context.fetch(queryVariantUrl),
        new Promise((_, reject) => setTimeout(() => reject(new Error('query media fetch hung')), 1000)),
    ]);
    assert.equal(await queryResponse.text(), cleanMediaText);

    // Force processM3U8 to throw immediately. The wrapper must resolve with the original,
    // still-readable response rather than hanging or returning a consumed body.
    context.__tasTest.StreamInfosByUrl[failOpenUrl] = new Proxy({}, {
        set() { throw new Error('synthetic processing failure'); },
    });
    const failOpenResponse = await Promise.race([
        context.fetch(failOpenUrl),
        new Promise((_, reject) => setTimeout(() => reject(new Error('fail-open media fetch hung')), 1000)),
    ]);
    assert.equal(await failOpenResponse.text(), cleanMediaText, 'processing error returned original response');
    assert.ok(logs.some(line => line.includes('Media-playlist processing failed open')), 'fail-open logged');
}


async function testPlayerVideoTargetAndPauseIntent() {
    let playCalls = 0;
    const pageAdVideo = { isConnected: true, dataset: { tasAdHidden: '1' }, paused: true, ended: false };
    const playerVideo = {
        isConnected: true,
        dataset: {},
        paused: false,
        ended: false,
        play() { playCalls++; return Promise.resolve(); },
    };
    const playerRoot = {
        isConnected: true,
        getElementsByTagName(tag) { return tag === 'video' ? [playerVideo] : []; },
        querySelector() { return null; },
        appendChild() {},
    };
    const { context, listeners } = createBrowserContext({
        videos: [pageAdVideo, playerVideo],
        playerRoot,
    });
    assert.equal(context.__tasTest.getPlayerVideoElement(), playerVideo, 'player-root video preferred over page-first video');
    const visibility = listeners.visibilitychange?.at(-1);
    assert.equal(typeof visibility, 'function', 'visibility handler installed');

    context.document.hidden = true;
    playerVideo.paused = false;
    visibility();
    context.document.hidden = false;
    playerVideo.paused = true;
    context.__tasTest.playerBufferState.userPauseIntent = true;
    visibility();
    assert.equal(playCalls, 0, 'user pause intent prevents focus auto-resume');

    context.__tasTest.playerBufferState.userPauseIntent = false;
    visibility();
    assert.equal(playCalls, 1, 'non-user pause may be resumed');
}

async function main() {
    await testRouteGuards();
    await testGraphqlScoping();
    await testWorkerBridgeRestriction();
    await testHlsV2AndFailOpen();
    await testPlayerVideoTargetAndPauseIntent();
    console.log('PASS: route guards');
    console.log('PASS: live-only GraphQL rewriting');
    console.log('PASS: worker bridge restrictions');
    console.log('PASS: V2/raw/query HLS handling');
    console.log('PASS: async HLS fail-open (no hung response)');
    console.log('PASS: player-owned video targeting and pause intent');
}

main().catch(error => {
    console.error(error.stack || error);
    process.exitCode = 1;
});
