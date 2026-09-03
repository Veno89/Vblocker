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
const expectedVersionMatch = source.match(/Veno Twitch Stability Fork (\d+\.\d+\.\d+)/);
assert.ok(expectedVersionMatch, 'Veno version found in resource header');
const expectedVenoVersion = expectedVersionMatch[1];
source = source.slice(0, endMarker) + `
    // processM3U8 normally runs inside the injected worker, whose bootloader owns
    // this request map. Supply the same dependency for direct worker-function tests.
    const pendingFetchRequests = window.__tasPendingFetchRequests;
    window.__tasTest = {
        hookWorkerFetch,
        processM3U8,
        stripAdSegments,
        createStreamInfo,
        handleWorkerFetchRequest,
        getPlayerVideoElement,
        monitorPlayerBuffering,
        startDriftCorrection,
        doTwitchPlayerTask,
        hideTwitchAdOverlays,
        updateAdblockBanner,
        playerBufferState,
        get pendingFetchRequests() { return pendingFetchRequests; },
        get pendingWorkerCrashRecovery() { return pendingWorkerCrashRecovery; },
        get activeTwitchWorkerGeneration() { return activeTwitchWorkerGeneration; },
        get StreamInfos() { return StreamInfos; },
        get StreamInfosByUrl() { return StreamInfosByUrl; },
        get BackupPlayerTypes() { return [...BackupPlayerTypes]; },
        get ForceAccessTokenPlayerType() { return ForceAccessTokenPlayerType; }
    };
` + source.slice(endMarker);

function makeResponse(body, { status = 200, headers = {}, url = '' } = {}) {
    const response = new Response(body, { status, headers });
    try { Object.defineProperty(response, 'url', { value: url, configurable: true }); } catch {}
    return response;
}

function createFakeTimers(startAt = 1_000_000) {
    let now = startAt;
    let nextId = 1;
    const tasks = new Map();

    const normalizeDelay = value => {
        const parsed = Number(value);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
    };
    const schedule = (kind, callback, delay, args) => {
        const id = nextId++;
        const normalizedDelay = normalizeDelay(delay);
        tasks.set(id, {
            id,
            kind,
            callback,
            args,
            delay: normalizedDelay,
            dueAt: now + normalizedDelay,
        });
        return id;
    };
    const clear = id => tasks.delete(id);
    const flushMicrotasks = async (rounds = 6) => {
        for (let i = 0; i < rounds; i++) await Promise.resolve();
    };
    const advanceBy = async milliseconds => {
        const target = now + normalizeDelay(milliseconds);
        let executions = 0;
        while (true) {
            await flushMicrotasks();
            let next = null;
            for (const task of tasks.values()) {
                if (task.dueAt <= target && (!next || task.dueAt < next.dueAt ||
                    (task.dueAt === next.dueAt && task.id < next.id))) {
                    next = task;
                }
            }
            if (!next) break;
            if (++executions > 20_000) throw new Error('fake timer runaway');
            now = next.dueAt;
            if (next.kind === 'interval' && tasks.has(next.id)) {
                next.dueAt += Math.max(1, next.delay);
            } else {
                tasks.delete(next.id);
            }
            next.callback(...next.args);
        }
        now = target;
        await flushMicrotasks();
    };

    class FakeDate extends Date {
        constructor(...args) {
            super(...(args.length ? args : [now]));
        }
        static now() { return now; }
    }

    return {
        Date: FakeDate,
        setTimeout: (callback, delay, ...args) => schedule('timeout', callback, delay, args),
        clearTimeout: clear,
        setInterval: (callback, delay, ...args) => schedule('interval', callback, delay, args),
        clearInterval: clear,
        advanceBy,
        flushMicrotasks,
        pendingTimers: () => [...tasks.values()].map(task => ({ ...task })),
        get now() { return now; },
    };
}

function createBrowserContext({
    hostname = 'www.twitch.tv',
    pathname = '/testchannel',
    search = '',
    baseFetch,
    videos = [],
    playerRoot = null,
    reactRoot = null,
    frameElement = null,
    workerSource = '',
    workerPendingFetchRequests,
    initialStorage = {},
    existingTasVersion,
    timers = createFakeTimers(),
} = {}) {
    const calls = [];
    const logs = [];
    const workers = [];
    const objectUrls = new Map();
    const revokedUrls = [];
    const xhrRequests = [];
    const scopeMessages = [];
    const fetchImpl = baseFetch || (async (input, init) => {
        const url = typeof input === 'string' ? input : input?.url || String(input);
        calls.push({ url, init });
        return makeResponse('{}', { url });
    });

    class BrowserURL extends URL {}
    BrowserURL.createObjectURL = blob => {
        const url = `blob:https://www.twitch.tv/mock-worker-${objectUrls.size + 1}`;
        objectUrls.set(url, blob);
        return url;
    };
    BrowserURL.revokeObjectURL = url => { revokedUrls.push(url); };

    class MockWorker {
        constructor(url, options) {
            this.url = url;
            this.options = options;
            this.listeners = Object.create(null);
            this.postedMessages = [];
            workers.push(this);
        }
        addEventListener(type, callback) {
            (this.listeners[type] ||= []).push(callback);
        }
        postMessage(message) { this.postedMessages.push(message); }
        dispatch(type, event) {
            return (this.listeners[type] || []).map(callback => callback(event));
        }
    }

    class MockXMLHttpRequest {
        constructor() {
            this.responseText = '';
        }
        open(method, url, async) {
            this.method = method;
            this.url = url;
            this.async = async;
            xhrRequests.push({ method, url, async });
        }
        overrideMimeType() {}
        send() {
            this.responseText = typeof workerSource === 'function'
                ? workerSource(this.url)
                : workerSource;
        }
    }

    const storage = new Map();
    for (const [key, value] of Object.entries(initialStorage)) {
        storage.set(String(key), String(value));
    }
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
        removeEventListener(type, callback) {
            const callbacks = listeners[type];
            if (!callbacks) return;
            const index = callbacks.indexOf(callback);
            if (index >= 0) callbacks.splice(index, 1);
        },
        getElementById() { return null; },
        querySelector(selector) {
            if (selector === '.video-player') return playerRoot;
            if (selector === '#root') return reactRoot;
            return null;
        },
        querySelectorAll() { return []; },
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
        postMessage: message => { scopeMessages.push(message); },
        addEventListener() {},
        removeEventListener() {},
        frameElement,
        URL: BrowserURL,
        URLSearchParams,
        Request,
        Response,
        Headers,
        Blob,
        AbortController,
        __tasPendingFetchRequests: workerPendingFetchRequests,
        Uint8Array,
        Map,
        Set,
        WeakMap,
        Object,
        Array,
        JSON,
        Math,
        Date: timers.Date,
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
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
        setInterval: timers.setInterval,
        clearInterval: timers.clearInterval,
    };
    if (existingTasVersion !== undefined) {
        sandbox.twitchAdSolutionsVersion = existingTasVersion;
    }
    sandbox.window = sandbox;
    sandbox.self = sandbox;
    const context = vm.createContext(sandbox);
    vm.runInContext(source, context, { filename: 'veno-twitch-stable.js', timeout: 5000 });
    return {
        context,
        calls,
        logs,
        listeners,
        storage,
        timers,
        workers,
        objectUrls,
        revokedUrls,
        xhrRequests,
        scopeMessages,
    };
}

function createReactPlayerHarness({ channelName = 'testchannel', stateName = 'Idle' } = {}) {
    const metrics = {
        pauseCalls: 0,
        playCalls: 0,
        setSrcCalls: [],
    };
    const videoListeners = Object.create(null);
    const video = {
        isConnected: true,
        dataset: {},
        paused: false,
        ended: false,
        muted: false,
        volume: 0.75,
        readyState: 4,
        networkState: 1,
        currentTime: 100,
        playbackRate: 1,
        videoWidth: 1920,
        buffered: {
            length: 1,
            start() { return 95; },
            end() { return 105; },
        },
        seekable: {
            length: 1,
            start() { return 95; },
            end() { return 104; },
        },
        addEventListener(type, callback) { (videoListeners[type] ||= []).push(callback); },
        removeEventListener() {},
        play() {
            metrics.playCalls++;
            this.paused = false;
            return Promise.resolve();
        },
        pause() {
            metrics.pauseCalls++;
            this.paused = true;
        },
        getVideoPlaybackQuality() { return { totalVideoFrames: 1000 }; },
    };
    const player = {
        core: {
            paused: false,
            state: {
                path: `https://usher.ttvnw.net/api/channel/hls/${channelName}.m3u8?sig=x`,
                position: 100,
                bufferedPosition: 105,
                muted: false,
                volume: 0.75,
                quality: { group: 'chunked' },
            },
        },
        isPaused() { return video.paused; },
        getHTMLVideoElement() { return video; },
        getBufferDuration() { return 5; },
        getState() { return stateName; },
        pause() { video.pause(); },
        play() { return video.play(); },
    };
    const playerState = {
        props: { content: { type: 'live' } },
        setInitialPlaybackSettings() {},
        setSrc(options) { metrics.setSrcCalls.push(options); },
    };
    const playerHolder = {
        setPlayerActive() {},
        props: { mediaPlayerInstance: { playerInstance: player } },
    };
    const fiberRoot = {
        stateNode: playerHolder,
        child: { stateNode: playerState, child: null, sibling: null },
        sibling: null,
    };
    const reactRoot = {
        _reactRootContainer: { _internalRoot: { current: fiberRoot } },
    };
    return { reactRoot, player, playerState, video, videoListeners, metrics };
}

function makeMasterPlaylist(variantUrl, { resolution = '1280x720' } = {}) {
    return [
        '#EXTM3U',
        `#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=${resolution},FRAME-RATE=60,CODECS="avc1.4d401f,mp4a.40.2"`,
        variantUrl,
        '',
    ].join('\n');
}

function makeMediaPlaylist({ sequence = 1, marker = '', segments = [] } = {}) {
    const lines = ['#EXTM3U', `#EXT-X-MEDIA-SEQUENCE:${sequence}`];
    if (marker) lines.push(marker);
    for (const segment of segments) {
        lines.push(`#EXTINF:2.0,${segment.live ? 'live' : ''}`);
        lines.push(segment.url);
    }
    lines.push('');
    return lines.join('\n');
}

function seedStreamInfo(context, mediaUrl, channelName = 'testchannel') {
    const streamInfo = context.__tasTest.createStreamInfo(channelName, '#EXTM3U\n', '?sig=x&token=y');
    streamInfo.Urls[mediaUrl] = {
        Resolution: '1280x720',
        FrameRate: '60',
        Codecs: 'avc1.4d401f,mp4a.40.2',
        Audio: '',
        Video: '',
        Subtitles: '',
        Url: mediaUrl,
    };
    context.__tasTest.StreamInfos[channelName] = streamInfo;
    context.__tasTest.StreamInfosByUrl[mediaUrl] = streamInfo;
    return streamInfo;
}

function validWorkerSource(marker) {
    return `/* ${marker} */\nWebAssembly; fetch; postMessage; MediaSource;\n${'x'.repeat(6000)}`;
}

function createTrackedVideo({
    src,
    muted = false,
    paused = false,
    display = '',
    displayPriority = '',
} = {}) {
    let currentDisplay = display;
    let currentDisplayPriority = displayPriority;
    const metrics = { pauseCalls: 0, playCalls: 0 };
    const style = {
        get display() { return currentDisplay; },
        set display(value) { currentDisplay = String(value); },
        getPropertyValue(name) { return name === 'display' ? currentDisplay : ''; },
        getPropertyPriority(name) { return name === 'display' ? currentDisplayPriority : ''; },
        setProperty(name, value, priority = '') {
            if (name === 'display') {
                currentDisplay = String(value);
                currentDisplayPriority = String(priority);
            }
        },
        removeProperty(name) {
            if (name === 'display') {
                const previous = currentDisplay;
                currentDisplay = '';
                currentDisplayPriority = '';
                return previous;
            }
            return '';
        },
    };
    const video = {
        tagName: 'VIDEO',
        isConnected: true,
        currentSrc: src || '',
        dataset: {},
        muted,
        paused,
        ended: false,
        style,
        getAttribute(name) { return name === 'src' ? this.currentSrc : null; },
        pause() { metrics.pauseCalls++; this.paused = true; },
        play() { metrics.playCalls++; this.paused = false; return Promise.resolve(); },
    };
    return { video, metrics };
}

async function testRouteGuards() {
    const vod = createBrowserContext({ pathname: '/videos/123456' });
    assert.equal(vod.context.venoTwitchStabilityVersion, undefined, 'VOD route untouched');

    const vodEmbed = createBrowserContext({ hostname: 'player.twitch.tv', pathname: '/', search: '?video=v123' });
    assert.equal(vodEmbed.context.venoTwitchStabilityVersion, undefined, 'VOD embed untouched');

    const chat = createBrowserContext({ pathname: '/popout/testchannel/chat' });
    assert.equal(chat.context.venoTwitchStabilityVersion, undefined, 'chat-only route untouched');

    const clipsHost = createBrowserContext({ hostname: 'clips.twitch.tv', pathname: '/SomeClipSlug' });
    assert.equal(clipsHost.context.venoTwitchStabilityVersion, undefined, 'clips.twitch.tv route untouched');

    const channelClip = createBrowserContext({ pathname: '/testchannel/clip/SomeClipSlug' });
    assert.equal(channelClip.context.venoTwitchStabilityVersion, undefined,
        '/<channel>/clip/<slug> route untouched');

    const directChatEmbed = createBrowserContext({
        pathname: '/embed/testchannel/chat',
        search: '?parent=example.test',
        frameElement: {},
    });
    assert.equal(directChatEmbed.context.venoTwitchStabilityVersion, undefined,
        'official /embed/<channel>/chat route untouched');

    const collectionEmbed = createBrowserContext({
        hostname: 'player.twitch.tv',
        pathname: '/',
        search: '?collection=abc123&parent=example.test',
        frameElement: {},
    });
    assert.equal(collectionEmbed.context.venoTwitchStabilityVersion, undefined,
        'collection VOD embed untouched');

    const liveChannelWins = createBrowserContext({
        hostname: 'player.twitch.tv',
        pathname: '/',
        search: '?channel=testchannel&video=v123&collection=abc123&parent=example.test',
        frameElement: {},
    });
    assert.equal(liveChannelWins.context.venoTwitchStabilityVersion, expectedVenoVersion,
        'explicit live channel takes precedence over stale VOD/collection parameters');

    const emptyChannelDoesNotWin = createBrowserContext({
        hostname: 'player.twitch.tv',
        pathname: '/',
        search: '?channel=&video=v123&parent=example.test',
        frameElement: {},
    });
    assert.equal(emptyChannelDoesNotWin.context.venoTwitchStabilityVersion, undefined,
        'empty channel parameter cannot override an explicit VOD embed');

    const live = createBrowserContext({ pathname: '/testchannel' });
    assert.equal(live.context.venoTwitchStabilityVersion, expectedVenoVersion,
        'live route runtime version matches the resource header');
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

    const lookalikePacket = {
        operationName: 'EvilPlaybackAccessTokenLookalike',
        variables: { isLive: true, isVod: false, vodID: '', playerType: 'site' },
    };
    await context.fetch('https://gql.twitch.tv/gql', {
        method: 'POST', headers: commonHeaders, body: JSON.stringify(lookalikePacket),
    });
    assert.deepEqual(JSON.parse(calls.at(-1).init.body), lookalikePacket,
        'operation-name substring lookalike is untouched by the window hook');

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

async function testWorkerBridgeResponseBodyDeadline() {
    const timers = createFakeTimers();
    const responseWithStalledBody = {
        status: 200,
        statusText: 'OK',
        ok: true,
        redirected: false,
        type: 'basic',
        url: 'https://gql.twitch.tv/gql',
        headers: new Headers({ 'content-type': 'application/json' }),
        text() { return new Promise(() => {}); },
    };
    const { context } = createBrowserContext({
        timers,
        baseFetch: async () => responseWithStalledBody,
    });
    let result = null;
    let rejection = null;
    context.__tasTest.handleWorkerFetchRequest({
        id: 'stalled-body',
        url: 'https://gql.twitch.tv/gql',
        options: {
            method: 'POST',
            body: JSON.stringify({ operationName: 'PlaybackAccessToken', variables: { isLive: true } }),
        },
    }).then(
        value => { result = value; },
        error => { rejection = error; },
    );
    await timers.flushMicrotasks(10);
    await timers.advanceBy(5000);

    assert.equal(rejection, null, 'bridge converts its deadline into a response payload');
    assert.ok(result, 'bridge settles when headers resolve but response.text never does');
    assert.equal(result.id, 'stalled-body');
    assert.match(result.error || '', /timeout/i, 'bridge reports the stalled response body as a timeout');
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

async function testOriginalMediaBodyReadDeadlineFailsOpen() {
    const timers = createFakeTimers();
    const mediaUrl = 'https://video-edge.example.net/live/stalled-original-body.m3u8';
    const originalBody = makeMediaPlaylist({
        sequence: 300,
        segments: [{ live: true, url: 'https://cdn.example.net/original-live.ts' }],
    });
    const stalledCloneRead = new Promise(() => {});
    const originalResponse = {
        status: 200,
        statusText: 'OK',
        ok: true,
        redirected: false,
        type: 'basic',
        url: mediaUrl,
        headers: new Headers({ 'content-type': 'application/vnd.apple.mpegurl' }),
        clone() { return { text: () => stalledCloneRead }; },
        text() { return Promise.resolve(originalBody); },
    };
    const { context, logs } = createBrowserContext({
        timers,
        baseFetch: async input => {
            assert.equal(String(input), mediaUrl);
            return originalResponse;
        },
    });
    context.__tasTest.hookWorkerFetch();

    let settledResponse = null;
    let settledError = null;
    context.fetch(mediaUrl).then(
        response => { settledResponse = response; },
        error => { settledError = error; },
    );
    await timers.flushMicrotasks(10);
    await timers.advanceBy(3_999);
    assert.equal(settledResponse, null, 'clone body read remains pending before its deadline');
    await timers.advanceBy(1);

    assert.equal(settledError, null, 'stalled clone body read fails open instead of rejecting playback');
    assert.strictEqual(settledResponse, originalResponse,
        'body-read deadline returns the untouched original Response object');
    assert.equal(await settledResponse.text(), originalBody,
        'the original response body remains independently readable after clone timeout');
    assert.ok(logs.some(line => line.includes('Media-playlist processing failed open') && /body read timed out/i.test(line)),
        'media clone timeout remains diagnosable');
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

async function testSingleMonitorTimerAcrossVisibilityTransitions() {
    const { context, listeners, timers } = createBrowserContext();
    const visibilityHandlers = listeners.visibilitychange || [];
    assert.ok(visibilityHandlers.length >= 1, 'visibility monitoring installed');

    context.document.hidden = false;
    for (let i = 0; i < 8; i++) {
        for (const handler of visibilityHandlers) handler();
    }
    await timers.advanceBy(100);

    const pending = timers.pendingTimers().filter(timer => timer.kind === 'timeout');
    assert.equal(pending.length, 1,
        'visibility wake-up replaces the prior monitor timeout instead of creating another polling chain');
}

async function testWorkerBootloaderPrefetchAndLatestMessages() {
    const marker = 'PREFETCHED_WORKER_SOURCE_MARKER';
    const workerJs = validWorkerSource(marker);
    const { context, workers, objectUrls, revokedUrls, xhrRequests } = createBrowserContext({
        workerSource: workerJs,
    });

    const firstOriginalUrl = 'blob:https://www.twitch.tv/original-worker-1';
    const firstWorker = new context.Worker(firstOriginalUrl, { name: 'first' });
    const firstInjectedBlob = objectUrls.get(firstWorker.url);
    assert.ok(firstInjectedBlob, 'intercepted worker receives a generated Blob URL');
    const firstBootloader = await firstInjectedBlob.text();
    assert.match(firstBootloader, new RegExp(marker), 'generated worker embeds the source already prefetched on the main thread');
    assert.doesNotThrow(() => new Function(firstBootloader), 'generated worker bootloader is valid JavaScript');
    assert.doesNotMatch(firstBootloader, /const workerString\s*=\s*getWasmWorkerJs\s*\(/,
        'generated worker does not synchronously fetch its source a second time');
    assert.equal(revokedUrls.includes(firstOriginalUrl), false,
        'wrapper does not revoke a caller-owned worker Blob that Twitch may reuse');
    assert.equal(xhrRequests.filter(request => request.url === firstOriginalUrl).length, 1,
        'original worker source fetched exactly once');

    const secondOriginalUrl = 'blob:https://www.twitch.tv/original-worker-2';
    const secondWorker = new context.Worker(secondOriginalUrl, { name: 'second' });
    assert.equal(workers.at(-1), secondWorker, 'second intercepted worker is the active worker');
    assert.ok(revokedUrls.includes(firstWorker.url), 'script-owned prior injected Blob is revoked on worker replacement');
    assert.equal(revokedUrls.includes(secondOriginalUrl), false, 'replacement source Blob remains caller-owned');

    context.__tasTest.playerBufferState.inAdBreak = false;
    firstWorker.dispatch('message', {
        data: { key: 'UpdateAdBlockBanner', hasAds: true, isStrippingAdSegments: true },
    });
    assert.equal(context.__tasTest.playerBufferState.inAdBreak, false,
        'late inbound state from a replaced worker is ignored');
    secondWorker.dispatch('message', {
        data: { key: 'UpdateAdBlockBanner', hasAds: true, isStrippingAdSegments: true },
    });
    assert.equal(context.__tasTest.playerBufferState.inAdBreak, true,
        'same state message from the latest worker is accepted');
    secondWorker.dispatch('message', {
        data: { key: 'UpdateAdBlockBanner', hasAds: false, isStrippingAdSegments: false },
    });
    await assert.doesNotReject(async () => {
        await Promise.all(secondWorker.dispatch('message', { data: null }));
        await Promise.all(secondWorker.dispatch('message', { data: 'unexpected primitive' }));
    }, 'both active-worker message listeners ignore null and primitive payloads');

    await context.fetch('https://gql.twitch.tv/gql', {
        method: 'POST',
        headers: new Headers({
            'X-Device-Id': 'latest-device',
            Authorization: 'OAuth latest',
            'Client-Version': '2.0.0',
            'Client-Session-Id': 'latest-session',
        }),
        body: JSON.stringify({
            operationName: 'PlaybackAccessToken',
            variables: { isLive: true, isVod: false, vodID: '', playerType: 'site' },
        }),
    });
    assert.equal(firstWorker.postedMessages.length, 0, 'replaced worker receives no later state updates');
    const latestKeys = secondWorker.postedMessages.map(message => message.key);
    assert.ok(latestKeys.includes('UpdateDeviceId'));
    assert.ok(latestKeys.includes('UpdateAuthorizationHeader'));
    assert.ok(latestKeys.includes('UpdateClientVersion'));
    assert.ok(latestKeys.includes('UpdateClientSession'));
}

async function testRejectedWorkerCandidatePreservesCurrentWorker() {
    const validUrl = 'blob:https://www.twitch.tv/current-video-worker';
    const rejectedUrl = 'blob:https://www.twitch.tv/non-video-worker';
    const { context, logs, revokedUrls } = createBrowserContext({
        workerSource: url => url === validUrl
            ? validWorkerSource('CURRENT_VIDEO_WORKER')
            : '/* deliberately not a video worker */ postMessage("ready");',
    });

    const validWorker = new context.Worker(validUrl);
    const validInjectedUrl = validWorker.url;
    const rejectedWorker = new context.Worker(rejectedUrl);

    assert.equal(rejectedWorker.url, rejectedUrl,
        'a weak-signal Twitch worker candidate is left unmodified');
    assert.equal(revokedUrls.includes(validInjectedUrl), false,
        'rejecting a later candidate does not revoke the current injected worker');
    assert.ok(logs.some(line => line.includes('insufficient video-worker signals')),
        'weak-signal rejection remains diagnosable');

    context.__tasTest.playerBufferState.inAdBreak = false;
    validWorker.dispatch('message', {
        data: { key: 'UpdateAdBlockBanner', hasAds: true, isStrippingAdSegments: true },
    });
    assert.equal(context.__tasTest.playerBufferState.inAdBreak, true,
        'the prior valid video worker remains current and its messages are still handled');
}

async function testWorkerRouteTransitionIsolationAndReenable() {
    const harness = createReactPlayerHarness({ channelName: 'routechannel', stateName: 'Playing' });
    const {
        context, objectUrls, revokedUrls, xhrRequests, calls, scopeMessages,
    } = createBrowserContext({
        reactRoot: harness.reactRoot,
        videos: [harness.video],
        workerSource: validWorkerSource('ROUTE_TRANSITION_WORKER'),
    });
    const currentOriginalUrl = 'blob:https://www.twitch.tv/route-current-worker';
    const currentWorker = new context.Worker(currentOriginalUrl);
    const currentInjectedUrl = currentWorker.url;
    const liveGeneration = context.__tasTest.activeTwitchWorkerGeneration;
    assert.ok(objectUrls.has(currentInjectedUrl), 'live route starts with an injected current video worker');
    const currentBootloader = await objectUrls.get(currentInjectedUrl).text();
    assert.match(currentBootloader,
        /message\.key == 'UpdateRouteAllowed'[\s\S]{0,200}VenoPlaybackAllowed = message\.value === true/,
        'worker bootloader accepts only literal true when applying route-allowed messages');

    const mediaUrl = 'https://video-edge.example.net/live/route-disabled.m3u8';
    const streamInfo = seedStreamInfo(context, mediaUrl, 'routechannel');
    streamInfo.LastSeenAt = 654_321;
    streamInfo.BreakGeneration = 7;
    const disabledInput = makeMediaPlaylist({
        sequence: 400,
        marker: '#EXT-X-DATERANGE:CLASS="twitch-stitched-ad"',
        segments: [{ live: false, url: 'https://cdn.example.net/adsquared/route-disabled.ts' }],
    });
    const snapshotStreamEffects = () => ({
        lastSeenAt: streamInfo.LastSeenAt,
        isShowingAd: streamInfo.IsShowingAd,
        breakGeneration: streamInfo.BreakGeneration,
        isStripping: streamInfo.IsStrippingAdSegments,
        numStripped: streamInfo.NumStrippedAdSegments,
        activeBackup: streamInfo.ActiveBackupPlayerType,
        earlyReloadCount: streamInfo.EarlyReloadCount,
        requestedAds: [...streamInfo.RequestedAds],
    });

    currentWorker.postedMessages.length = 0;
    context.document.location.pathname = '/videos/123456';
    context.document.location.search = '';
    context.__tasTest.monitorPlayerBuffering();
    context.__tasTest.monitorPlayerBuffering();
    assert.deepEqual(
        currentWorker.postedMessages.filter(message => message.key === 'UpdateRouteAllowed').map(message => message.value),
        [false],
        'live-to-VOD transition tells the current worker to disable playback interception',
    );

    const stateBeforeDisabledProcess = snapshotStreamEffects();
    scopeMessages.length = 0;
    let auxiliaryCalls = 0;
    const disabledResult = await context.__tasTest.processM3U8(mediaUrl, disabledInput, async () => {
        auxiliaryCalls++;
        throw new Error('route-disabled processing must not fetch a backup');
    });
    assert.equal(disabledResult, disabledInput, 'route-disabled playlist input remains byte-identical');
    assert.deepEqual(snapshotStreamEffects(), stateBeforeDisabledProcess,
        'route-disabled playlist processing leaves stream state untouched');
    assert.equal(auxiliaryCalls, 0, 'route-disabled playlist processing starts no auxiliary fetch');
    assert.equal(scopeMessages.length, 0, 'route-disabled playlist processing posts no worker action');

    await Promise.all(currentWorker.dispatch('message', {
        data: {
            key: 'FetchRequest',
            value: {
                id: 'excluded-route-request',
                url: 'https://gql.twitch.tv/gql',
                options: {
                    method: 'POST',
                    body: JSON.stringify({
                        operationName: 'PlaybackAccessToken',
                        variables: { isLive: true, login: 'routechannel' },
                    }),
                },
            },
        },
    }));
    const blockedBridge = currentWorker.postedMessages.find(message =>
        message.key === 'FetchResponse' && message.value?.id === 'excluded-route-request');
    assert.match(blockedBridge?.value?.error || '', /disabled outside live-playback scope/i,
        'current worker bridge refuses even an otherwise valid request on the excluded route');
    assert.equal(calls.length, 0, 'excluded worker bridge request never reaches the network');

    const injectedBlobCount = objectUrls.size;
    const xhrCount = xhrRequests.length;
    const excludedOriginalUrl = 'blob:https://www.twitch.tv/route-excluded-worker';
    const excludedWorker = new context.Worker(excludedOriginalUrl);
    assert.equal(excludedWorker.url, excludedOriginalUrl,
        'Twitch-origin worker created on a VOD route uses its original URL');
    assert.equal(objectUrls.size, injectedBlobCount, 'excluded-route worker creates no injected Blob');
    assert.equal(xhrRequests.length, xhrCount, 'excluded-route worker source is not prefetched');
    assert.equal(context.__tasTest.activeTwitchWorkerGeneration, liveGeneration,
        'excluded-route worker does not replace the current video-worker generation');
    assert.equal(revokedUrls.includes(currentInjectedUrl), false,
        'excluded-route worker does not revoke the current injected Blob');

    context.document.location.pathname = '/routechannel';
    context.__tasTest.monitorPlayerBuffering();
    context.__tasTest.monitorPlayerBuffering();
    assert.deepEqual(
        currentWorker.postedMessages.filter(message => message.key === 'UpdateRouteAllowed').map(message => message.value),
        [false, true],
        'returning to live tells the same current worker to resume interception',
    );

    context.__tasTest.playerBufferState.inAdBreak = false;
    excludedWorker.dispatch('message', {
        data: { key: 'UpdateAdBlockBanner', hasAds: true, isStrippingAdSegments: true },
    });
    assert.equal(context.__tasTest.playerBufferState.inAdBreak, false,
        'worker created while excluded never becomes an active message source');
    currentWorker.dispatch('message', {
        data: { key: 'UpdateAdBlockBanner', hasAds: true, isStrippingAdSegments: true },
    });
    assert.equal(context.__tasTest.playerBufferState.inAdBreak, true,
        'the original current worker can update live player state after route re-enable');

    const reloadsBefore = harness.metrics.setSrcCalls.length;
    excludedWorker.dispatch('message', { data: { key: 'ReloadPlayer', kind: 'post-ad' } });
    assert.equal(harness.metrics.setSrcCalls.length, reloadsBefore,
        'excluded worker cannot issue player actions after returning live');
    currentWorker.dispatch('message', { data: { key: 'ReloadPlayer', kind: 'post-ad' } });
    assert.equal(harness.metrics.setSrcCalls.length, reloadsBefore + 1,
        'the original current worker can issue player actions after returning live');
    assert.equal(harness.metrics.setSrcCalls.at(-1).isNewMediaPlayerInstance, false,
        're-enabled post-ad action remains a soft reload');
}

async function testWorkerCrashRecoveryCooldownAndGenerationGuard() {
    const harness = createReactPlayerHarness({ channelName: 'crashchannel', stateName: 'Playing' });
    const { context, timers, logs } = createBrowserContext({
        reactRoot: harness.reactRoot,
        videos: [harness.video],
        workerSource: validWorkerSource('CRASH_RECOVERY_WORKER'),
    });
    const worker = new context.Worker('blob:https://www.twitch.tv/crash-recovery-worker');
    const state = context.__tasTest.playerBufferState;
    state.lastReloadAt = timers.now;
    const initialMonitorTimers = timers.pendingTimers().filter(timer => timer.kind === 'timeout');
    assert.equal(initialMonitorTimers.length, 1, 'one player-monitor retry chain exists before the crash');

    worker.dispatch('error', { message: 'synthetic IVS failure' });
    const deferredRecovery = context.__tasTest.pendingWorkerCrashRecovery;
    assert.equal(typeof deferredRecovery, 'function', 'active crash records one deferred recovery callback');
    assert.equal(harness.metrics.setSrcCalls.length, 0, 'crash recovery does not bypass the active reload cooldown');
    assert.equal(timers.pendingTimers().filter(timer => timer.kind === 'timeout').length, 1,
        'crash recovery reuses the single monitor timer instead of creating a polling chain');

    worker.dispatch('error', { message: 'duplicate event from the same crash' });
    assert.equal(context.__tasTest.pendingWorkerCrashRecovery, deferredRecovery,
        'duplicate crash event does not replace or multiply the deferred recovery');
    assert.equal(logs.filter(line => line.includes('IVS WASM worker crashed')).length, 1,
        'duplicate error is logged only once');
    assert.equal(logs.filter(line => line.includes('Worker crash recovery deferred')).length, 1,
        'cooldown deferral is logged only once while the monitor retries');

    await timers.advanceBy(14_999);
    assert.equal(harness.metrics.setSrcCalls.length, 0, 'deferred crash remains suppressed until cooldown expiry');
    await timers.advanceBy(2);
    assert.equal(harness.metrics.setSrcCalls.length, 1,
        'the existing monitor performs exactly one recovery after the remaining cooldown');
    assert.equal(harness.metrics.setSrcCalls[0].isNewMediaPlayerInstance, true,
        'worker-crash recovery rebuilds the media player');
    assert.equal(harness.metrics.setSrcCalls[0].refreshAccessToken, true,
        'worker-crash recovery refreshes the access token');
    assert.equal(context.__tasTest.pendingWorkerCrashRecovery, null,
        'successful recovery clears the pending callback');
    worker.dispatch('error', { message: 'late duplicate event' });
    assert.equal(harness.metrics.setSrcCalls.length, 1, 'late duplicate error cannot trigger another recovery');

    const replacementHarness = createReactPlayerHarness({ channelName: 'replacementchannel', stateName: 'Playing' });
    const replacementCase = createBrowserContext({
        reactRoot: replacementHarness.reactRoot,
        videos: [replacementHarness.video],
        workerSource: validWorkerSource('GENERATION_GUARD_WORKER'),
    });
    const oldWorker = new replacementCase.context.Worker('blob:https://www.twitch.tv/crashed-old-worker');
    replacementCase.context.__tasTest.playerBufferState.lastReloadAt = replacementCase.timers.now;
    oldWorker.dispatch('error', { message: 'old worker crash' });
    const staleRecovery = replacementCase.context.__tasTest.pendingWorkerCrashRecovery;
    assert.equal(typeof staleRecovery, 'function', 'old worker recovery is pending before replacement');

    new replacementCase.context.Worker('blob:https://www.twitch.tv/replacement-worker');
    assert.equal(replacementCase.context.__tasTest.pendingWorkerCrashRecovery, null,
        'worker replacement clears the old pending recovery');
    staleRecovery();
    await replacementCase.timers.advanceBy(15_001);
    assert.equal(replacementHarness.metrics.setSrcCalls.length, 0,
        'captured old-worker recovery is inert after the active generation changes');
}

async function testWorkerPostAdMessageForcesSoftReload() {
    const harness = createReactPlayerHarness({ channelName: 'postadchannel', stateName: 'Playing' });
    const { context } = createBrowserContext({
        reactRoot: harness.reactRoot,
        videos: [harness.video],
        workerSource: validWorkerSource('POST_AD_WORKER'),
    });
    const worker = new context.Worker('blob:https://www.twitch.tv/post-ad-worker');

    worker.dispatch('message', { data: { key: 'ReloadPlayer', kind: 'post-ad' } });

    assert.equal(harness.metrics.setSrcCalls.length, 1,
        'worker-confirmed post-ad reload is not discarded by the healthy-player heuristic');
    assert.equal(harness.metrics.setSrcCalls[0].isNewMediaPlayerInstance, false,
        'post-ad reload remains soft');
    assert.equal(harness.metrics.setSrcCalls[0].refreshAccessToken, false,
        'post-ad soft reload does not rotate the access token');
}

async function testAutomaticEarlyReloadMainThreadCooldown() {
    const harness = createReactPlayerHarness({ channelName: 'cooldownchannel', stateName: 'Playing' });
    const { context, timers } = createBrowserContext({
        reactRoot: harness.reactRoot,
        videos: [harness.video],
        workerSource: validWorkerSource('EARLY_RELOAD_WORKER'),
    });
    const replacedWorker = new context.Worker('blob:https://www.twitch.tv/early-worker-old');
    const activeWorker = new context.Worker('blob:https://www.twitch.tv/early-worker-active');
    harness.video.readyState = 2;
    context.__tasTest.playerBufferState.lastReloadAt = timers.now;

    replacedWorker.dispatch('message', { data: { key: 'ReloadPlayer', kind: 'early' } });
    assert.equal(harness.metrics.setSrcCalls.length, 0, 'replaced worker cannot request recovery');

    activeWorker.dispatch('message', { data: { key: 'ReloadPlayer', kind: 'early' } });
    assert.equal(harness.metrics.setSrcCalls.length, 0,
        'automatic early reload is suppressed inside the rolling 15-second main-thread cooldown');
    assert.ok(activeWorker.postedMessages.some(message => message.key === 'ReloadSkipped'),
        'cooldown suppression is signalled back to the active worker');

    activeWorker.postedMessages.length = 0;
    await timers.advanceBy(15_001);
    activeWorker.dispatch('message', { data: { key: 'ReloadPlayer', kind: 'early' } });
    assert.equal(harness.metrics.setSrcCalls.length, 1,
        'automatic early reload proceeds after the main-thread cooldown');
    assert.equal(harness.metrics.setSrcCalls[0].isNewMediaPlayerInstance, true);
    assert.equal(harness.metrics.setSrcCalls[0].refreshAccessToken, true);
    assert.equal(activeWorker.postedMessages.some(message => message.key === 'ReloadSkipped'), false,
        'successful post-cooldown reload does not emit ReloadSkipped');
}

async function testAuxiliaryFetchDeadlineFailsOpen() {
    const masterUrl = 'https://usher.ttvnw.net/api/channel/hls/deadlinechannel.m3u8?sig=x&token=y';
    const variantUrl = 'https://video-edge.example.net/live/deadline.m3u8';
    const masterText = makeMasterPlaylist(variantUrl);
    let masterRequestCount = 0;
    let secondOriginalResponse = null;
    const never = new Promise(() => {});
    const { context, timers, calls } = createBrowserContext({
        baseFetch: async (input, init) => {
            const url = typeof input === 'string' ? input : input?.url || String(input);
            calls.push({ url, init });
            if (url.startsWith('https://usher.ttvnw.net/api/channel/hls/deadlinechannel.m3u8')) {
                masterRequestCount++;
                const response = makeResponse(masterText, { url });
                if (masterRequestCount === 2) secondOriginalResponse = response;
                return response;
            }
            if (url === variantUrl) return never;
            return makeResponse('{}', { url });
        },
    });
    context.__tasTest.hookWorkerFetch();
    await context.fetch(masterUrl);

    let settledResponse = null;
    let settledError = null;
    context.fetch(masterUrl).then(
        response => { settledResponse = response; },
        error => { settledError = error; },
    );
    await timers.flushMicrotasks(10);
    assert.ok(calls.some(call => call.url === variantUrl), 'existing-master health probe started');
    await timers.advanceBy(5000);

    assert.equal(settledError, null, 'stalled auxiliary operation does not reject the player request');
    assert.ok(settledResponse, 'outer master request settles after the auxiliary deadline');
    assert.equal(settledResponse.status, secondOriginalResponse.status,
        'deadline path preserves the original response status');
    assert.equal(await settledResponse.text(), masterText, 'fail-open response body remains readable');
}

async function testBackupSearchDeadlineFailsOpen() {
    const { context, timers, logs } = createBrowserContext();
    const mainUrl = 'https://video-edge.example.net/live/stalled-backup-main.m3u8';
    const streamInfo = seedStreamInfo(context, mainUrl, 'stalledbackupchannel');
    const backupVariants = new Set();
    for (const playerType of context.__tasTest.BackupPlayerTypes) {
        const variantUrl = `https://video-edge.example.net/stalled/${playerType}.m3u8`;
        streamInfo.BackupEncodingsM3U8Cache[playerType] = makeMasterPlaylist(variantUrl);
        backupVariants.add(variantUrl);
    }
    const marker = '#EXT-X-DATERANGE:CLASS="twitch-stitched-ad"';
    const adMain = makeMediaPlaylist({
        sequence: 70,
        marker,
        segments: [{ live: false, url: 'https://cdn.example.net/adsquared/stalled-main.ts' }],
    });
    const never = new Promise(() => {});
    const attempted = [];
    let settledText = null;
    let settledError = null;
    context.__tasTest.processM3U8(mainUrl, adMain, async url => {
        attempted.push(url);
        assert.ok(backupVariants.has(url), `unexpected auxiliary URL ${url}`);
        return never;
    }).then(
        value => { settledText = value; },
        error => { settledError = error; },
    );
    await timers.flushMicrotasks(10);
    assert.ok(attempted.length >= 1, 'backup media search began');
    await timers.advanceBy(9000);

    assert.equal(settledError, null, 'backup-search deadline fails open instead of rejecting playback');
    assert.equal(typeof settledText, 'string', 'ad playlist processing settles after bounded backup attempts');
    assert.equal(streamInfo.ActiveBackupPlayerType, null, 'never-settling backup is not committed');
    assert.ok(logs.some(line => /deadline|timed out/i.test(line)), 'deadline failure remains diagnosable');
}

async function testNamedMinimalBackupAndContaminationRejection() {
    const marker = '#EXT-X-DATERANGE:CLASS="twitch-stitched-ad"';
    const mainUrl = 'https://video-edge.example.net/live/minimal-main.m3u8';
    const adMain = makeMediaPlaylist({
        sequence: 10,
        marker,
        segments: [{ live: false, url: 'https://cdn.example.net/adsquared/main-ad.ts' }],
    });

    const cleanCase = createBrowserContext();
    const cleanInfo = seedStreamInfo(cleanCase.context, mainUrl);
    cleanInfo.LastPlayerReload = cleanCase.timers.now;
    cleanInfo.PinnedBackupPlayerType = 'embed';
    const cleanVariants = new Map();
    for (const playerType of cleanCase.context.__tasTest.BackupPlayerTypes) {
        const variantUrl = `https://video-edge.example.net/backup/${playerType}.m3u8`;
        cleanInfo.BackupEncodingsM3U8Cache[playerType] = makeMasterPlaylist(variantUrl);
        cleanVariants.set(variantUrl, playerType);
    }
    const cleanCalls = [];
    const cleanResult = await cleanCase.context.__tasTest.processM3U8(mainUrl, adMain, async url => {
        cleanCalls.push(url);
        const playerType = cleanVariants.get(url);
        assert.ok(playerType, `unexpected backup URL ${url}`);
        return makeResponse(makeMediaPlaylist({
            sequence: 20,
            segments: [{ live: true, url: `https://cdn.example.net/live-${playerType}.ts` }],
        }), { url });
    });
    assert.equal(cleanVariants.get(cleanCalls[0]), 'embed', 'minimal mode tries the named pinned candidate, not a numeric array slot');
    assert.equal(cleanInfo.ActiveBackupPlayerType, 'embed', 'clean pinned candidate committed');
    assert.match(cleanResult, /live-embed\.ts/);

    const contaminatedCase = createBrowserContext();
    const contaminatedInfo = seedStreamInfo(contaminatedCase.context, mainUrl);
    contaminatedInfo.LastPlayerReload = contaminatedCase.timers.now;
    contaminatedInfo.PinnedBackupPlayerType = 'embed';
    const contaminatedVariants = new Map();
    for (const playerType of contaminatedCase.context.__tasTest.BackupPlayerTypes) {
        const variantUrl = `https://video-edge.example.net/contaminated/${playerType}.m3u8`;
        contaminatedInfo.BackupEncodingsM3U8Cache[playerType] = makeMasterPlaylist(variantUrl);
        contaminatedVariants.set(variantUrl, playerType);
    }
    const contaminatedCalls = [];
    await contaminatedCase.context.__tasTest.processM3U8(mainUrl, adMain, async url => {
        contaminatedCalls.push(url);
        return makeResponse(makeMediaPlaylist({
            sequence: 30,
            marker,
            segments: [{ live: false, url: `https://cdn.example.net/adsquared/${contaminatedVariants.get(url)}.ts` }],
        }), { url });
    });
    assert.equal(contaminatedVariants.get(contaminatedCalls[0]), 'embed', 'contamination case still uses named minimal candidate');
    assert.equal(contaminatedInfo.ActiveBackupPlayerType, null,
        'minimal mode never commits an ad-marked candidate merely because it is the only probe');
}

async function testStaleBackupSearchHasNoLateSideEffects() {
    const marker = '#EXT-X-DATERANGE:CLASS="twitch-stitched-ad",X-TV-TWITCH-AD-CLICK-URLS="https://ads.example/click"';
    const originalPlaylist = makeMediaPlaylist({
        sequence: 80,
        marker,
        segments: [{ live: false, url: 'https://cdn.example.net/adsquared/stale-main.ts' }],
    });
    const sentinelFailure = ['new-break-only', 765_432];
    const sentinelContamination = 'new-break-contaminated';
    const installNewerBreakState = streamInfo => {
        streamInfo.FailedBackupPlayerTypes.clear();
        streamInfo.FailedBackupPlayerTypes.set(...sentinelFailure);
        streamInfo.LoggedBackupAdsByType = new Set([sentinelContamination]);
        streamInfo.CycleRescuedThisBreak = false;
        streamInfo.ConsecutiveTokenFetchFailures = 6;
        streamInfo.LoggedTokenFailureStreak = true;
    };
    const assertNewerBreakState = (streamInfo, label) => {
        assert.deepEqual([...streamInfo.FailedBackupPlayerTypes], [sentinelFailure],
            `${label}: stale failure does not mark a player type in the newer break`);
        assert.deepEqual([...streamInfo.LoggedBackupAdsByType], [sentinelContamination],
            `${label}: stale ad result does not contaminate the newer break`);
        assert.equal(streamInfo.CycleRescuedThisBreak, false,
            `${label}: stale clean result does not claim the newer break was cycle-rescued`);
        assert.equal(streamInfo.ConsecutiveTokenFetchFailures, 6,
            `${label}: stale result preserves the newer break token-failure count`);
        assert.equal(streamInfo.LoggedTokenFailureStreak, true,
            `${label}: stale result preserves the newer break token-failure diagnostic`);
    };

    const scenarios = [
        {
            name: 'break ended before contaminated media',
            mutate(streamInfo) { streamInfo.IsShowingAd = false; },
            response(url) {
                return makeResponse(makeMediaPlaylist({
                    sequence: 90,
                    marker,
                    segments: [{ live: false, url: 'https://cdn.example.net/adsquared/stale-backup.ts' }],
                }), { url });
            },
        },
        {
            name: 'newer generation before failed media',
            mutate(streamInfo) { streamInfo.BreakGeneration++; },
            response(url) { return makeResponse('temporarily unavailable', { status: 503, url }); },
        },
        {
            name: 'newer generation before clean cycle result',
            mutate(streamInfo) {
                streamInfo.BreakGeneration++;
                streamInfo.ConsecutiveAllStrippedPolls = 1;
                streamInfo.LastCommittedBackupPlayerType = 'embed';
            },
            response(url) {
                return makeResponse(makeMediaPlaylist({
                    sequence: 91,
                    segments: [{ live: true, url: 'https://cdn.example.net/stale-clean.ts' }],
                }), { url });
            },
        },
    ];
    for (const scenario of scenarios) {
        const { context, timers, scopeMessages, logs } = createBrowserContext();
        const scenarioSlug = scenario.name.replace(/[^a-z0-9]+/gi, '-');
        const mainUrl = `https://video-edge.example.net/live/stale-${scenarioSlug}.m3u8`;
        const streamInfo = seedStreamInfo(context, mainUrl, 'stalechannel');
        streamInfo.LastPlayerReload = timers.now;
        streamInfo.PinnedBackupPlayerType = 'site';
        const delayedVariant = `https://video-edge.example.net/backup/stale-${scenarioSlug}.m3u8`;
        streamInfo.BackupEncodingsM3U8Cache.site = makeMasterPlaylist(delayedVariant);
        let resolveFetch;
        const delayedFetch = new Promise(resolve => { resolveFetch = resolve; });
        const pending = context.__tasTest.processM3U8(mainUrl, originalPlaylist, async url => {
            assert.equal(url, delayedVariant);
            return delayedFetch;
        });
        await timers.flushMicrotasks(10);
        assert.equal(typeof resolveFetch, 'function', `${scenario.name}: backup request is in flight`);
        scopeMessages.length = 0;
        scenario.mutate(streamInfo);
        installNewerBreakState(streamInfo);
        resolveFetch(scenario.response(delayedVariant));
        const result = await pending;

        assert.equal(result, originalPlaylist, `${scenario.name}: stale search returns the untouched input playlist`);
        assert.equal(streamInfo.ActiveBackupPlayerType, null, `${scenario.name}: stale backup is not committed`);
        assert.equal(streamInfo.NumStrippedAdSegments, 0, `${scenario.name}: stale continuation does not strip segments`);
        assert.equal(streamInfo.IsStrippingAdSegments, false, `${scenario.name}: stripping flag remains clear`);
        assert.equal(streamInfo.EarlyReloadCount, 0, `${scenario.name}: no late early-reload accounting`);
        assert.equal(scopeMessages.some(message => message.key === 'ReloadPlayer' || message.key === 'PauseResumePlayer'), false,
            `${scenario.name}: no late player action emitted`);
        assert.ok(logs.some(line => line.includes('Discarded stale backup search')),
            `${scenario.name}: stale discard remains diagnosable`);
        assertNewerBreakState(streamInfo, scenario.name);
    }

    // Exercise the separate await used to read a failed access-token response body.
    // The break becomes stale while text() is pending; none of the newer break's
    // token-failure diagnostics may be overwritten when that old body arrives.
    {
        const workerPendingFetchRequests = new Map();
        const { context, timers, scopeMessages, logs } = createBrowserContext({ workerPendingFetchRequests });
        const mainUrl = 'https://video-edge.example.net/live/stale-token-body.m3u8';
        const streamInfo = seedStreamInfo(context, mainUrl, 'staletokenchannel');
        streamInfo.LastPlayerReload = timers.now;
        streamInfo.PinnedBackupPlayerType = 'site';
        let auxiliaryCalls = 0;
        const pending = context.__tasTest.processM3U8(mainUrl, originalPlaylist, async () => {
            auxiliaryCalls++;
            throw new Error('stale token failure must stop before an auxiliary playlist fetch');
        });
        await timers.flushMicrotasks(10);

        const fetchMessage = scopeMessages.find(message => message.key === 'FetchRequest');
        assert.ok(fetchMessage,
            `cold backup search requested an access token (messages=${JSON.stringify(scopeMessages)}, logs=${JSON.stringify(logs.slice(-5))})`);
        const requestId = fetchMessage.value.id;
        const pendingFetch = context.__tasTest.pendingFetchRequests.get(requestId);
        assert.ok(pendingFetch, 'access-token bridge request is pending');
        let resolveTokenBody;
        let tokenBodyReadStarted = false;
        const delayedTokenBody = new Promise(resolve => { resolveTokenBody = resolve; });
        timers.clearTimeout(pendingFetch.timeoutId);
        context.__tasTest.pendingFetchRequests.delete(requestId);
        pendingFetch.resolve({
            status: 403,
            text() {
                tokenBodyReadStarted = true;
                return delayedTokenBody;
            },
        });
        await timers.flushMicrotasks(10);
        assert.equal(tokenBodyReadStarted, true, 'failed token response body read is in flight');

        streamInfo.BreakGeneration++;
        installNewerBreakState(streamInfo);
        scopeMessages.length = 0;
        let result = null;
        let pendingError = null;
        let pendingSettled = false;
        pending.then(
            value => { result = value; pendingSettled = true; },
            error => { pendingError = error; pendingSettled = true; },
        );
        resolveTokenBody('denied by synthetic token endpoint');
        await timers.flushMicrotasks(20);

        assert.equal(pendingError, null, 'stale failed-token path does not reject');
        assert.equal(pendingSettled, true,
            `stale failed-token path settles (messages=${JSON.stringify(scopeMessages)}, logs=${JSON.stringify(logs.slice(-5))})`);
        assert.equal(result, originalPlaylist, 'stale failed-token body returns the untouched input playlist');
        assert.equal(auxiliaryCalls, 0, 'stale token result starts no backup playlist request');
        assert.equal(streamInfo.ActiveBackupPlayerType, null, 'stale token result commits no backup');
        assert.equal(streamInfo.NumStrippedAdSegments, 0, 'stale token result strips no segments');
        assert.equal(scopeMessages.some(message => message.key === 'ReloadPlayer' || message.key === 'PauseResumePlayer'), false,
            'stale token result emits no player action');
        assert.ok(logs.some(line => line.includes('Discarded stale backup search')),
            'stale token-body discard remains diagnosable');
        assertNewerBreakState(streamInfo, 'failed token response body');
    }
}

async function testSoftNoStripReloadAndBreakReset() {
    const { context, scopeMessages } = createBrowserContext();
    const mainUrl = 'https://video-edge.example.net/live/no-strip-main.m3u8';
    const streamInfo = seedStreamInfo(context, mainUrl, 'nostripchannel');
    const siteVariant = 'https://video-edge.example.net/backup/site-no-strip.m3u8';
    streamInfo.BackupEncodingsM3U8Cache.site = makeMasterPlaylist(siteVariant);
    const confirmedAdMarker = '#EXT-X-DATERANGE:CLASS="twitch-stitched-ad",X-TV-TWITCH-AD-AD-SESSION-ID="confirmed"';
    const adWithLiveMedia = makeMediaPlaylist({
        sequence: 40,
        marker: confirmedAdMarker,
        segments: [{ live: true, url: 'https://cdn.example.net/main-live.ts' }],
    });
    const cleanBackup = makeMediaPlaylist({
        sequence: 50,
        segments: [{ live: true, url: 'https://cdn.example.net/backup-live.ts' }],
    });
    await context.__tasTest.processM3U8(mainUrl, adWithLiveMedia, async url => {
        assert.equal(url, siteVariant);
        return makeResponse(cleanBackup, { url });
    });
    assert.equal(streamInfo.NumStrippedAdSegments, 0, 'backup swap handled break without injecting stripped segments');
    assert.equal(streamInfo.LastCommittedBackupPlayerType, 'site');

    for (let i = 0; i < 3; i++) {
        const cleanMain = makeMediaPlaylist({
            sequence: 60 + i,
            segments: [{ live: true, url: `https://cdn.example.net/clean-${i}.ts` }],
        });
        await context.__tasTest.processM3U8(mainUrl, cleanMain, async () => {
            throw new Error('clean end-of-break polls should not fetch a backup');
        });
    }

    const reloadMessages = scopeMessages.filter(message => message.key === 'ReloadPlayer');
    assert.equal(reloadMessages.at(-1)?.kind, 'post-ad', 'no-strip non-autoplay swap requests a soft post-ad reload');
    assert.equal(streamInfo.IsShowingAd, false);
    assert.equal(streamInfo.LastCommittedBackupPlayerType, null, 'committed type cleared after reload-kind decision');
    assert.equal(streamInfo.CycleRescuedThisBreak, false);
    assert.equal(streamInfo.TotalAllStrippedPolls, 0);
    assert.equal(streamInfo.FreezeStartedAt, 0);
    assert.equal(streamInfo.AdBreakStartedAt, 0);
}

async function testRecoveryMediaSequenceForMixedPlaylist() {
    const { context } = createBrowserContext();
    const streamInfo = context.__tasTest.createStreamInfo('sequencechannel', '#EXTM3U\n', '?sig=x');
    const mixed = makeMediaPlaylist({
        sequence: 100,
        segments: [
            { live: false, url: 'https://cdn.example.net/adsquared/ad-100.ts' },
            { live: true, url: 'https://cdn.example.net/live-101.ts' },
            { live: true, url: 'https://cdn.example.net/live-102.ts' },
        ],
    });
    context.__tasTest.stripAdSegments(mixed, false, streamInfo);
    assert.equal(streamInfo.RecoveryStartSeq, 101,
        'recovery sequence tracks the first retained live segment, not merely the count of retained segments');

    const allAd = makeMediaPlaylist({
        sequence: 200,
        segments: [{ live: false, url: 'https://cdn.example.net/adsquared/ad-200.ts' }],
    });
    const recovered = context.__tasTest.stripAdSegments(allAd, false, streamInfo);
    assert.match(recovered, /#EXT-X-MEDIA-SEQUENCE:101(?:\r?\n|$)/);
    assert.match(recovered, /live-101\.ts/);
}

async function testPodLengthClamp() {
    const cases = [
        { raw: '0', expected: 1, label: 'zero' },
        { raw: '999999', expected: 8, label: 'huge' },
        { raw: 'not-a-number', expected: 1, label: 'malformed' },
        { raw: null, expected: 1, label: 'missing' },
    ];
    for (const testCase of cases) {
        const { context } = createBrowserContext();
        const url = `https://video-edge.example.net/live/pod-${testCase.label}.m3u8`;
        const streamInfo = context.__tasTest.createStreamInfo(`pod-${testCase.label}`, '#EXTM3U\n', '?sig=x');
        context.__tasTest.StreamInfosByUrl[url] = streamInfo;
        const podAttribute = testCase.raw === null
            ? ''
            : `,X-TV-TWITCH-AD-POD-LENGTH="${testCase.raw}"`;
        const playlist = makeMediaPlaylist({
            marker: `#EXT-X-DATERANGE:CLASS="twitch-stitched-ad"${podAttribute}`,
            segments: [{ live: true, url: `https://cdn.example.net/pod-${testCase.label}.ts` }],
        });
        await context.__tasTest.processM3U8(url, playlist, async () => {
            throw new Error('missing resolution should avoid backup search');
        });
        assert.equal(streamInfo.PodLength, testCase.expected,
            `${testCase.label} pod length clamped into inclusive 1..8 safety bounds`);
    }
}

async function testHiddenAdVideoRestorationAcrossRouteAndRecycle() {
    const harness = createReactPlayerHarness({ channelName: 'mediarestore', stateName: 'Playing' });
    const tracked = createTrackedVideo({
        src: 'https://delivery.media-amazon.com/display-ad.mp4',
        muted: false,
        paused: false,
        display: 'inline-block',
        displayPriority: 'important',
    });
    let overlay = null;
    const playerRoot = {
        isConnected: true,
        getElementsByTagName(tag) { return tag === 'video' ? [harness.video] : []; },
        querySelector(selector) { return selector === '.tas-adblock-overlay' ? overlay : null; },
        appendChild(node) { if (node.className === 'tas-adblock-overlay') overlay = node; },
    };
    const { context } = createBrowserContext({
        reactRoot: harness.reactRoot,
        playerRoot,
        videos: [harness.video, tracked.video],
    });
    const assertHidden = label => {
        assert.equal(tracked.video.dataset.tasAdHidden, '1', `${label}: node marked hidden`);
        assert.equal(tracked.video.style.getPropertyValue('display'), 'none', `${label}: display hidden`);
        assert.equal(tracked.video.style.getPropertyPriority('display'), 'important', `${label}: hide is important`);
        assert.equal(tracked.video.muted, true, `${label}: ad media muted`);
        assert.equal(tracked.video.paused, true, `${label}: ad media paused`);
    };
    const assertRestored = label => {
        assert.equal(tracked.video.dataset.tasAdHidden, undefined, `${label}: marker removed`);
        assert.equal(tracked.video.style.getPropertyValue('display'), 'inline-block', `${label}: exact display restored`);
        assert.equal(tracked.video.style.getPropertyPriority('display'), 'important', `${label}: display priority restored`);
        assert.equal(tracked.video.muted, false, `${label}: exact mute state restored`);
        assert.equal(tracked.video.paused, false, `${label}: originally-playing node resumed`);
    };

    context.__tasTest.updateAdblockBanner({ hasAds: true, isStrippingAdSegments: true });
    assertHidden('initial live ad');

    harness.player.getHTMLVideoElement = () => tracked.video;
    context.__tasTest.hideTwitchAdOverlays();
    assertRestored('recycled primary video');
    assert.equal(tracked.metrics.playCalls, 1, 'primary-video recycle resumes prior playing state once');

    harness.player.getHTMLVideoElement = () => harness.video;
    context.__tasTest.updateAdblockBanner({ hasAds: true, isStrippingAdSegments: true });
    assertHidden('second live ad');
    context.document.location.pathname = '/videos/123456';
    context.document.location.search = '';
    context.__tasTest.monitorPlayerBuffering();
    assertRestored('VOD route transition');
    assert.equal(tracked.metrics.playCalls, 2, 'VOD exclusion resumes prior playing state');

    context.document.location.pathname = '/mediarestore';
    context.__tasTest.monitorPlayerBuffering();
    context.__tasTest.updateAdblockBanner({ hasAds: true, isStrippingAdSegments: true });
    assertHidden('third live ad');
    context.document.location.pathname = '/popout/mediarestore/chat';
    context.__tasTest.monitorPlayerBuffering();
    assertRestored('chat route transition');
    assert.equal(tracked.metrics.playCalls, 3, 'chat exclusion resumes prior playing state');
}

async function testForcedRecoveryBypassesHealthyReloadSkip() {
    const harness = createReactPlayerHarness({ channelName: 'forcechannel' });
    const { context, logs } = createBrowserContext({
        reactRoot: harness.reactRoot,
        videos: [harness.video],
    });

    context.__tasTest.doTwitchPlayerTask(false, true, 'early');
    assert.equal(harness.metrics.setSrcCalls.length, 0, 'ordinary reload remains suppressed for a healthy low-latency player');

    context.__tasTest.doTwitchPlayerTask(false, true, 'early', {
        force: true,
        reason: 'confirmed-wedge',
    });
    assert.equal(harness.metrics.setSrcCalls.length, 1, 'confirmed recovery forces reload despite superficial healthy media state');
    assert.equal(harness.metrics.setSrcCalls[0].isNewMediaPlayerInstance, true);
    assert.equal(harness.metrics.setSrcCalls[0].refreshAccessToken, true);
    assert.ok(logs.some(line => line.includes('confirmed-wedge')), 'forced reload reason is diagnostic');
}

async function testConfirmedPostBreakWedgeForcesRecovery() {
    const harness = createReactPlayerHarness({ channelName: 'wedgechannel', stateName: 'Playing' });
    const { context, logs } = createBrowserContext({
        reactRoot: harness.reactRoot,
        videos: [harness.video],
    });
    const state = context.__tasTest.playerBufferState;
    state.inAdBreak = false;
    state.wedgePrevInAdBreak = true;
    state.lastReloadAt = 0;
    state.userPauseIntent = false;

    // The first tick observes the ad->live edge and records the decoder baseline.
    context.__tasTest.monitorPlayerBuffering();
    for (let i = 0; i < 12; i++) {
        harness.video.currentTime += 1;
        harness.player.core.state.position += 1;
        harness.player.core.state.bufferedPosition += 1;
        context.__tasTest.monitorPlayerBuffering();
    }

    assert.equal(harness.metrics.pauseCalls, 1, 'first confirmed wedge action is a bounded pause/play nudge');
    assert.equal(harness.metrics.setSrcCalls.length, 1,
        'recurring confirmed wedge reaches hard reload even though readyState and latency look healthy');
    assert.equal(harness.metrics.setSrcCalls[0].isNewMediaPlayerInstance, true);
    assert.ok(logs.some(line => line.includes('confirmed-wedge')), 'wedge-triggered forced reload carries its reason');
}

async function testChannelChangeClearsTransientRecoveryState() {
    const harness = createReactPlayerHarness({ channelName: 'newchannel', stateName: 'Idle' });
    const { context, timers } = createBrowserContext({
        reactRoot: harness.reactRoot,
        videos: [harness.video],
    });
    const state = context.__tasTest.playerBufferState;
    context.__tasTest.startDriftCorrection(harness.video);
    assert.equal(harness.video.playbackRate, 1.1, 'test precondition: drift correction active');
    Object.assign(state, {
        channelName: 'oldchannel',
        hasStreamStarted: true,
        position: 88,
        videoCurrentTime: 88,
        bufferedPosition: 89,
        bufferDuration: 0.1,
        numSame: 3,
        fixAttempts: 2,
        lastFixTime: 900_000,
        lastBackupSwitchAt: 900_000,
        lastReloadAt: 900_000,
        recoveryReloadUsed: true,
        userPauseIntent: true,
        loggedPauseIntent: true,
        weJustPaused: 900_000,
        inAdBreak: true,
        hasHadData: true,
        adStallStartAt: 900_000,
        lastAdStallReloadAt: 900_000,
        lastDriftStartedAt: 900_000,
        wedgePrevInAdBreak: true,
        wedgeEvalsRemaining: 20,
        wedgeLastTime: 80,
        wedgeLastFrames: 900,
        wedgeEvidence: 4,
        wedgeHealthy: 2,
        wedgeActions: 1,
    });

    context.__tasTest.monitorPlayerBuffering();
    assert.equal(state.channelName, 'newchannel', 'channel change detected even while old channel was marked in-ad');
    assert.equal(state.hasStreamStarted, false);
    assert.equal(state.position, 100, 'new channel position baseline recorded after transient state reset');
    assert.equal(state.videoCurrentTime, 100, 'new channel media-clock baseline recorded');
    assert.equal(state.bufferedPosition, 105, 'new channel buffered-position baseline recorded');
    assert.equal(state.bufferDuration, 5, 'new channel buffer baseline recorded');
    for (const field of [
        'numSame', 'fixAttempts',
        'lastFixTime', 'lastBackupSwitchAt', 'lastReloadAt', 'weJustPaused',
        'adStallStartAt', 'lastAdStallReloadAt', 'lastDriftStartedAt',
        'wedgeEvalsRemaining', 'wedgeEvidence', 'wedgeHealthy', 'wedgeActions',
    ]) {
        assert.equal(state[field] || 0, 0, `${field} cleared on channel change`);
    }
    assert.equal(state.userPauseIntent, false);
    assert.equal(state.loggedPauseIntent, false);
    assert.equal(state.inAdBreak, false);
    assert.equal(state.recoveryReloadUsed, false);
    assert.equal(state.hasHadData, true, 'ready new-channel video establishes fresh data evidence in the same tick');
    assert.equal(state.wedgePrevInAdBreak, false);
    assert.equal(harness.video.playbackRate, 1, 'channel reset cancels drift correction');
    assert.equal(timers.pendingTimers().filter(timer => timer.kind === 'interval').length, 0,
        'channel reset leaves no drift interval alive');
}

async function main() {
    const cases = [
        ['route guards', testRouteGuards],
        ['live-only GraphQL rewriting', testGraphqlScoping],
        ['worker bridge restrictions', testWorkerBridgeRestriction],
        ['worker bridge response-body deadline', testWorkerBridgeResponseBodyDeadline],
        ['V2/raw/query HLS handling and async fail-open', testHlsV2AndFailOpen],
        ['original media body-read deadline fails open', testOriginalMediaBodyReadDeadlineFailsOpen],
        ['player-owned video targeting and pause intent', testPlayerVideoTargetAndPauseIntent],
        ['one buffer-monitor timer across visibility transitions', testSingleMonitorTimerAcrossVisibilityTransitions],
        ['prefetched worker bootloader, Blob cleanup, and latest-worker messages', testWorkerBootloaderPrefetchAndLatestMessages],
        ['rejected worker candidate preserves the current valid worker', testRejectedWorkerCandidatePreservesCurrentWorker],
        ['worker route transitions isolate excluded pages and re-enable live actions', testWorkerRouteTransitionIsolationAndReenable],
        ['worker crash recovery deduplicates, waits, and honors generation', testWorkerCrashRecoveryCooldownAndGenerationGuard],
        ['worker post-ad message forces a soft reload', testWorkerPostAdMessageForcesSoftReload],
        ['automatic early reload obeys the main-thread cooldown', testAutomaticEarlyReloadMainThreadCooldown],
        ['auxiliary fetch deadline fails open', testAuxiliaryFetchDeadlineFailsOpen],
        ['backup-search deadline fails open', testBackupSearchDeadlineFailsOpen],
        ['named minimal backup selection rejects contamination', testNamedMinimalBackupAndContaminationRejection],
        ['stale backup search has no late side effects', testStaleBackupSearchHasNoLateSideEffects],
        ['no-strip soft reload and end-of-break state reset', testSoftNoStripReloadAndBreakReset],
        ['mixed-playlist recovery media sequence', testRecoveryMediaSequenceForMixedPlaylist],
        ['pod length is clamped to safe bounds', testPodLengthClamp],
        ['hidden ad video state restores on recycle and excluded routes', testHiddenAdVideoRestorationAcrossRouteAndRecycle],
        ['confirmed recovery bypasses healthy reload skip', testForcedRecoveryBypassesHealthyReloadSkip],
        ['confirmed post-break wedge forces recovery', testConfirmedPostBreakWedgeForcesRecovery],
        ['channel transition clears transient recovery state', testChannelChangeClearsTransientRecoveryState],
    ];
    const failures = [];
    for (const [name, test] of cases) {
        try {
            await test();
            console.log(`PASS: ${name}`);
        } catch (error) {
            failures.push({ name, error });
            console.error(`FAIL: ${name}\n${error.stack || error}`);
        }
    }
    if (failures.length > 0) {
        throw new Error(`${failures.length} validation group(s) failed`);
    }
}

const suiteWatchdog = setTimeout(() => {
    console.error('FAIL: validation suite did not settle within 15 seconds');
    process.exitCode = 1;
}, 15_000);
main().then(
    () => { clearTimeout(suiteWatchdog); },
    error => {
        clearTimeout(suiteWatchdog);
        console.error(error.stack || error);
        process.exitCode = 1;
    },
);
