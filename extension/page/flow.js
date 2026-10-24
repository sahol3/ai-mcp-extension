/*
 * ai-mcp — Google Flow site module (MAIN world, flow.google.com)
 *
 * v2, rewritten 2026-09-30 for the new Flow. In Sep 2026 Flow left labs.google for its own
 * origin: labs.google/fx/tools/flow now 308s to https://flow.google.com/, which is a Boq
 * Angular app (AiSandboxAngularFrontend). There is no tRPC, no /fx/api/auth/session and no
 * page-side aisandbox-pa traffic any more — every call is a batchexecute RPC on the page's own
 * origin, authorised by the WIZ_global_data XSRF token exactly like Gemini.
 *
 * GENERATION IS HUMAN-GATED, ON PURPOSE, AND THIS MODULE RESPECTS THAT.
 *
 *   - The app replaces the public `grecaptcha.enterprise.execute` with a wrapper that forces
 *     `action: "extension_hijack_detected"` and keeps a private copy for itself (bundle fn
 *     S6a). A token minted by anything else is labelled as a hijack; the one test call made
 *     on 2026-09-30 came back PERMISSION_DENIED / PUBLIC_ERROR_UNUSUAL_ACTIVITY.
 *   - The prompt box's submit() refuses events whose isTrusted is false.
 *   - DevTools-protocol input cannot attach to the tab, because the page embeds a
 *     www.google.com/recaptcha frame.
 *
 * Those are deliberate anti-automation controls. This module never calls grecaptcha, never
 * reaches for the private execute, never fakes isTrusted and never touches the reCAPTCHA
 * frame — every one of those would put hijack-labelled traffic on the user's account. What it
 * does instead is everything around the click: pick the project, mode, model, aspect ratio,
 * count, duration and resolution through the real settings panel (synthetic clicks work
 * there), type the prompt, then wait for the user's own Generate click and collect the media
 * the app produced. Reads (credits, models, projects, contents) are plain RPCs and need no
 * token.
 */
(() => {
  'use strict';

  const A = window.__AIMCP__;
  if (!A) { console.error('[ai-mcp] core missing — flow module cannot load'); return; }
  const { $$, pick, describe, visible, clickEl, typeInto, editorText, sleep, waitFor, findByText, closeMenu, el } = A.util;
  const H = A.H;
  const SITE_VERSION = 2;

  const FLOW_PATH = /^\/fx\/(?:[a-z]{2}\/)?tools\/flow/i;
  const BATCH_PATH = '/_/AiSandboxAngularFrontend/data/batchexecute';

  /*
   * rpcid -> method, extracted from the app's own bundles (build
   * boq_labs-ai-sandbox-frontend_20260928.12_p0). Registrations look like
   * `new _.qy("nzlxg", Resp, Req, [..., "/VideoFxService.GetCredits"])`. The full table incl.
   * People-service ids is in docs/flow-rpcs-2026-09.txt.
   */
  const RPC_NAMES = {
    JJH6Ub: 'AiSandbox.AddUserAcknowledgement',
    pmmFvb: 'AiSandbox.AddUserRegistration',
    cO7JOb: 'AiSandbox.CheckAppAvailability',
    md9xJf: 'AiSandbox.CheckFeatureAvailability',
    KV2T2d: 'AiSandbox.CheckToolAvailability',
    NfrxTb: 'AiSandbox.CheckUserAcknowledgement',
    jHPbke: 'AiSandbox.CreateProject',
    dpwTMe: 'AiSandbox.CreateScene',
    QI2zvc: 'AiSandbox.DeleteProject',
    Adnnof: 'AiSandbox.DeleteScene',
    LPzVkd: 'AiSandbox.FetchUserRecommendations',
    Uhba0c: 'AiSandbox.GetMedia',
    ngNC2: 'AiSandbox.GetProject',
    X1yU8: 'AiSandbox.GetScene',
    xI9TVb: 'AiSandbox.GetUserPreferences',
    DviW9c: 'AiSandbox.GetUserVideoCreditStatusAction',
    e1OaUd: 'AiSandbox.GetWorkflow',
    GI4k8: 'AiSandbox.SearchProjectScenes',
    SIzNd: 'AiSandbox.SearchProjectWorkflows',
    OylIJd: 'AiSandbox.SearchUserProjects',
    Docasf: 'AiSandbox.SubmitFeedback',
    Kcr7Ub: 'AiSandbox.UpdateAgentInfo',
    o8DA4: 'AiSandbox.UpdateProjectInfo',
    bk2bVd: 'AiSandbox.UpdateScene',
    mu42vc: 'AiSandbox.UpdateUserPreferences',
    s6Qwyc: 'AiSandbox.UpdateUserRetentionNotificationCount',
    wDg3C: 'EntityService.BatchGetEntities',
    YIBQMe: 'EntityService.CopyEntity',
    C4BZMd: 'EntityService.CreateEntity',
    DLs3dd: 'EntityService.ListEntities',
    rzMKMb: 'EntityService.UpdateEntity',
    UaAwic: 'FlowAppletAgentService.AdminDeleteApplet',
    tmHIkc: 'FlowAppletAgentService.BlockApplet',
    HqMS3: 'FlowAppletAgentService.ClearAppletSession',
    VVrfbf: 'FlowAppletAgentService.CopyApplet',
    zpwzEe: 'FlowAppletAgentService.DeleteApplet',
    AmBK3b: 'FlowAppletAgentService.DeleteGoogleOwnedApplet',
    ipGN1: 'FlowAppletAgentService.DeleteSavedSharedApplet',
    AsR0Se: 'FlowAppletAgentService.ExportAppletSession',
    eDee9c: 'FlowAppletAgentService.FavoriteApplet',
    CSvxid: 'FlowAppletAgentService.ForkSharedApplet',
    e6lwif: 'FlowAppletAgentService.GetApplet',
    ZLaYcd: 'FlowAppletAgentService.GetAppletVersion',
    J0KDW: 'FlowAppletAgentService.GetSharedAppletVersion',
    tRARke: 'FlowAppletAgentService.ListApplets',
    qJcgMc: 'FlowAppletAgentService.ListSavedSharedApplets',
    CvpHmb: 'FlowAppletAgentService.RevertAppletVersion',
    Z8KLDf: 'FlowAppletAgentService.RunAppletAgent',
    cNQB4b: 'FlowAppletAgentService.RunAppletAgentSse',
    YRmDpc: 'FlowAppletAgentService.SeedApplet',
    vEIlvc: 'FlowAppletAgentService.ShareApplet',
    NpB2cd: 'FlowAppletAgentService.SubmitAppletReview',
    Ifmob: 'FlowAppletAgentService.UnblockApplet',
    TsaPHc: 'FlowAppletAgentService.UnfavoriteApplet',
    h4NnAe: 'FlowAppletAgentService.UnshareApplet',
    sd0GXe: 'FlowAppletAgentService.UpdateApplet',
    XbyPOc: 'FlowAppletAgentService.UpdateGoogleOwnedAppletMetadata',
    Az898d: 'FlowCreationAgentService.CancelTurn',
    csbIsb: 'FlowCreationAgentService.CreateSession',
    Dcn2Le: 'FlowCreationAgentService.DeleteSession',
    GN0Bre: 'FlowCreationAgentService.GetSession',
    mrlkwd: 'FlowCreationAgentService.ListSessions',
    P0WGvd: 'FlowCreationAgentService.RecordSessionView',
    TunYMc: 'FlowCreationAgentService.RenameSession',
    xNyCid: 'FlowCreationAgentService.StreamChat',
    ve2Lsc: 'FlowLikenessService.CheckUserLikenessEligibility',
    KaLHHf: 'FlowLikenessService.DeleteUserLikeness',
    lv2lXd: 'FlowLikenessService.GetLikenessRegistrationStatus',
    T3Zezf: 'FlowLikenessService.GetLikenessRegistrationUrl',
    DTaVef: 'FlowLikenessService.ListUserLikenesses',
    heTLee: 'FlowSearchFrontendService.SearchMedia',
    oWTRd: 'FlowService.AddWorkflowsToScene',
    cz8Z4b: 'FlowService.BatchDeleteAssets',
    BLIwAb: 'FlowService.BatchDeleteScenes',
    GLc8O: 'FlowService.BatchEnrichMedia',
    no0P6: 'FlowService.BatchGenerateAudio',
    ogiZ0b: 'FlowService.BatchGenerateImages',
    Hbi7j: 'FlowService.BatchGetCollections',
    Iyc41d: 'FlowService.BatchGetMedia',
    uRk1o: 'FlowService.BatchGetProjects',
    jtGUlf: 'FlowService.BatchGetScenes',
    yfXKib: 'FlowService.BatchGetSceneWorkflows',
    vrrFtb: 'FlowService.BatchGetWorkflows',
    WuwhI: 'FlowService.BatchLogFrontendEvents',
    kVdhHf: 'FlowService.BatchMoveToCollection',
    pGCYOe: 'FlowService.BatchUpdateWorkflows',
    CK0Pk: 'FlowService.CancelMediaGeneration',
    Dp1eae: 'FlowService.CheckUserCloudPermission',
    Sc7aEb: 'FlowService.CopyProjectMedia',
    OSd63c: 'FlowService.CopyScene',
    XKxtXb: 'FlowService.CopyWorkflow',
    Uxbujd: 'FlowService.CreateCollection',
    rqZuUc: 'FlowService.CreateScene',
    agJzFb: 'FlowService.GenerateContent',
    QiuWMe: 'FlowService.GetCollection',
    QLXvEd: 'FlowService.GetG1Interventions',
    as29s: 'FlowService.GetMedia',
    uurnC: 'FlowService.GetMediaUrl',
    HTrJv: 'FlowService.GetModels',
    Hnrtob: 'FlowService.GetProject',
    Zzl0ze: 'FlowService.GetProjectContents',
    UpteDb: 'FlowService.GetProjects',
    O12LBf: 'FlowService.GetScene',
    kDiqOe: 'FlowService.GetSceneWorkflow',
    uwAyfb: 'FlowService.GetSceneWorkflows',
    cMxpTd: 'FlowService.GetSharedMedia',
    Yizz8d: 'FlowService.GetUserSettings',
    L91dPd: 'FlowService.GetWorkflow',
    yvJRsc: 'FlowService.GrantG1Incentive',
    m1QyH: 'FlowService.InitializeFlowEnterprise',
    rEhmZd: 'FlowService.ListCollections',
    bOKtO: 'FlowService.ListMedia',
    yBhWQ: 'FlowService.ListModelStatuses',
    okjlg: 'FlowService.ListProjects',
    Xffewf: 'FlowService.ListScenes',
    ncZTKe: 'FlowService.ListSceneWorkflows',
    Mf1z1c: 'FlowService.ListUserFlowEnterpriseCloudProjects',
    LWkPYd: 'FlowService.ListUserWorkflows',
    kGwJ9b: 'FlowService.ListWorkflows',
    RaYiHf: 'FlowService.RecordG1InterventionInteraction',
    J2mwWb: 'FlowService.ShareMedia',
    L2jnw: 'FlowService.StreamGenerateContent',
    sAVZzc: 'FlowService.TransformImage',
    BLuntc: 'FlowService.UnshareMedia',
    O2COMe: 'FlowService.UpdateCollection',
    lt8g5: 'FlowService.UpdateMedia',
    BpMsoe: 'FlowService.UpdateScene',
    H5ewbd: 'FlowService.UpdateScenes',
    dtQlBe: 'FlowService.UpdateSceneWorkflow',
    GoMJte: 'FlowService.UpdateSceneWorkflows',
    DA4VGb: 'FlowService.UpdateUserSettings',
    iVqlKd: 'FlowService.UpdateVideoOffset',
    mYWVGd: 'FlowService.UpdateWorkflow',
    epopJ: 'FlowService.UploadGeneratedAudio',
    maseQ: 'FlowService.UploadImage',
    SPrCad: 'FlowService.UpsampleImage',
    syFRRe: 'FlowSharingService.GetProjectDetails',
    Qrv5xc: 'FlowSharingService.GetSharedProjects',
    uhRpkc: 'FlowSharingService.ShareProject',
    jIps6: 'VideoFxService.BatchAsyncGenerateVideoEditVideo',
    IJhj9c: 'VideoFxService.BatchAsyncGenerateVideoExperimental',
    fZytfe: 'VideoFxService.BatchAsyncGenerateVideoExtendVideo',
    MZZa6b: 'VideoFxService.BatchAsyncGenerateVideoReferenceImages',
    nprQif: 'VideoFxService.BatchAsyncGenerateVideoStartAndEndImage',
    eb1hJf: 'VideoFxService.BatchAsyncGenerateVideoStartImage',
    YhhmEf: 'VideoFxService.BatchAsyncGenerateVideoText',
    p0UkFb: 'VideoFxService.BatchAsyncGenerateVideoUpsampleVideo',
    jwpduf: 'VideoFxService.BatchCheckAsyncVideoGenerationStatus',
    rThb8d: 'VideoFxService.CheckFlowAvailability',
    Yw72Rc: 'VideoFxService.CreatePreamble',
    x9P9ne: 'VideoFxService.DeletePreamble',
    okiZaf: 'VideoFxService.DismissSiteContentIds',
    QZasKb: 'VideoFxService.GeneratePinholeGif',
    nzlxg: 'VideoFxService.GetCredits',
    cPZSdc: 'VideoFxService.GetFlowAppConfig',
    gS5h8c: 'VideoFxService.GetUserSettings',
    OqcWz: 'VideoFxService.ListPreambles',
    BejPuf: 'VideoFxService.LogMediaBookmark',
    e97Odc: 'VideoFxService.SetupStarterProjects',
    JnpaK: 'VideoFxService.UpdatePreamble',
    wX5DAe: 'VideoFxService.UpdateUserSettings',
  };

  const RPC = Object.fromEntries(Object.entries(RPC_NAMES).map(([id, name]) => [name.split('.').pop(), id]));

  /*
   * RPCs whose request carries a reCAPTCHA token (actions IMAGE_GENERATION, VIDEO_GENERATION,
   * AUDIO_GENERATION, UPLOAD_IMAGE, ...). flow_rpc refuses them: without a token they fail,
   * and with one minted from here they would be labelled "extension_hijack_detected".
   */
  const TOKEN_GATED = new Set([
    'BatchGenerateImages', 'BatchAsyncGenerateVideoText', 'BatchAsyncGenerateVideoStartImage',
    'BatchAsyncGenerateVideoStartAndEndImage', 'BatchAsyncGenerateVideoReferenceImages',
    'BatchAsyncGenerateVideoExtendVideo', 'BatchAsyncGenerateVideoEditVideo',
    'BatchAsyncGenerateVideoUpsampleVideo', 'BatchAsyncGenerateVideoExperimental', 'UpsampleImage',
    'TransformImage', 'UploadImage', 'BatchGenerateAudio', 'GenerateContent', 'StreamGenerateContent',
    'GeneratePinholeGif', 'StreamChat', 'RunAppletAgent', 'RunAppletAgentSse',
  ].map((n) => RPC[n]).filter(Boolean));

  const GENERATION_RPCS = new Set([...TOKEN_GATED].filter((id) => /Generate|Upsample|Transform/.test(RPC_NAMES[id])));

  // -------------------------------------------------------------- selectors

  const SEL = {
    promptBox: ['.ProseMirror[contenteditable="true"]', 'div[contenteditable="true"].ProseMirror', '[contenteditable="true"]'],
    generateButton: ['button[aria-label="Start generation"]', 'button.generate-icon-button'],
    settingsTrigger: ['button[aria-label="Settings trigger"]', 'button.settings-trigger-button'],
    modelFamily: ['button[aria-label="Select model family"]'],
    overlay: ['.cdk-overlay-container'],
    addMedia: ['button[aria-label="Add media menu"]'],
    addIngredients: ['button[aria-label="Add ingredients to the prompt box"]'],
    account: ['a[aria-label^="Google Account"]', 'a[href*="SignOutOptions"]'],
    signIn: ['a[href*="accounts.google.com/ServiceLogin"]', 'a[href*="accounts.google.com/v3/signin"]', 'button[aria-label*="Sign in" i]'],
    fileInput: ['input[type="file"]'],
    projectLink: ['a[href*="/project/"]'],
    video: ['video'],
  };

  // --------------------------------------------------------------- helpers

  const NEW_ORIGIN = () => location.hostname === 'flow.google.com';
  const onFlow = () => NEW_ORIGIN() || FLOW_PATH.test(location.pathname);
  const projectId = () => (location.pathname.match(/\/project\/([\w-]+)/i) ?? [])[1] ?? null;
  const tsIso = (t) => (Array.isArray(t) && typeof t[0] === 'number' ? new Date(t[0] * 1000).toISOString() : null);

  /*
   * The signed-in account avatar is itself an accounts.google.com link (SignOutOptions), so a
   * bare href match reads every signed-in page as signed out. The avatar's aria-label is the
   * positive signal.
   */
  function accountLabel() {
    const a = pick(SEL.account).el;
    return a ? (a.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim() : null;
  }
  function signedOut() {
    if (/accounts\.google\.com|\/signin/.test(location.href)) return true;
    if (accountLabel()) return false;
    return !!pick(SEL.signIn).el || !!findByText('Sign in', 'a,button');
  }

  function ready() {
    if (!onFlow()) return { ready: false, state: 'not_on_flow', path: location.pathname, hint: 'Navigate the tab to https://flow.google.com/' };
    if (signedOut()) return { ready: false, state: 'signed_out', hint: 'Sign in to Google in this browser, then reload flow.google.com.' };
    if (document.readyState !== 'complete') return { ready: false, state: 'loading' };
    const hasUi = !!pick(SEL.promptBox).el || !!pick(SEL.projectLink, { all: true }).els.length
      || !!findByText('New project', 'button,a');
    return hasUi
      ? { ready: true, state: 'app', project_id: projectId(), path: location.pathname }
      : { ready: false, state: 'app_shell_only', hint: 'Flow loaded but neither a prompt box nor the project list is visible yet.' };
  }

  /** Visible text with Material Symbols ligatures ("crop_16_9", "volume_up") removed. */
  function cleanLabel(el) {
    if (!el) return '';
    const parts = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const host = n.parentElement;
      if (host && host.closest('mat-icon, .material-symbols-outlined, .material-symbols-rounded, .google-symbols, .material-icons, i')) continue;
      parts.push(n.nodeValue);
    }
    let s = parts.join(' ').replace(/\s+/g, ' ').trim();
    // Some icons are plain spans. Flow's labels start with a capital, a digit or an emoji, so a
    // leading all-lowercase token ("videocam Video", "volume_up Omni") and a trailing snake_case
    // one or "info" ("720p info", "Nano Banana 2 arrow_drop_down") are ligatures.
    s = s.replace(/^[a-z][a-z0-9_]{2,}\s+(?=\S)/, '');
    s = s.replace(/\s+(?:[a-z]+_[a-z0-9_]+|info)$/, '');
    return s.trim();
  }
  const norm = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9.:]+/g, ' ').replace(/\s+/g, ' ').trim();

  // ------------------------------------------------------- batchexecute

  /** at / bl / f.sid / hl, from WIZ_global_data, backfilled from a captured request. */
  function tokens() {
    const w = window.WIZ_global_data || {};
    const out = { at: w.SNlM0e || null, bl: w.cfb2h || null, fsid: w.FdrFJe || null, hl: null };
    for (const r of A.net.match({ url: 'batchexecute' }).slice().reverse()) {
      try {
        const u = new URL(r.url, location.href);
        out.bl ||= u.searchParams.get('bl');
        out.fsid ||= u.searchParams.get('f.sid');
        out.hl ||= u.searchParams.get('hl');
      } catch {}
      if (!out.at) { const m = /(?:^|&)at=([^&]+)/.exec(r.req_body || ''); if (m) out.at = decodeURIComponent(m[1]); }
      if (out.at && out.bl && out.fsid && out.hl) break;
    }
    out.hl ||= (document.documentElement.lang || 'en').split('-')[0];
    return out;
  }

  const RPC_CODES = { 1: 'CANCELLED', 2: 'UNKNOWN', 3: 'INVALID_ARGUMENT', 4: 'DEADLINE_EXCEEDED', 5: 'NOT_FOUND', 7: 'PERMISSION_DENIED', 8: 'RESOURCE_EXHAUSTED', 9: 'FAILED_PRECONDITION', 13: 'INTERNAL', 14: 'UNAVAILABLE', 16: 'UNAUTHENTICATED' };

  /** `)]}'` + length-prefixed frames -> { rpcid: { data } | { error } }. */
  function parseBatch(text) {
    const out = {};
    for (const frame of A.net.parseGoogleChunks(String(text || ''))) {
      if (!Array.isArray(frame)) continue;
      for (const row of frame) {
        if (!Array.isArray(row) || row[0] !== 'wrb.fr') continue;
        const id = row[1] ?? '_';
        if (typeof row[2] === 'string') {
          try { out[id] = { data: JSON.parse(row[2]) }; } catch { out[id] = { data: row[2] }; }
        } else if (Array.isArray(row[5])) {
          const code = row[5][0];
          const detail = JSON.stringify(row[5][1] ?? null);
          out[id] = { error: { code, status: RPC_CODES[code] ?? String(code), reason: (/"(PUBLIC_ERROR_[A-Z_]+|[A-Z_]{8,})"/.exec(detail) || [])[1] ?? null } };
        } else {
          out[id] = { data: row[2] ?? null };
        }
      }
    }
    return out;
  }

  async function rpc(rpcid, inner, { raw = false } = {}) {
    const tok = tokens();
    if (!tok.at) throw new Error('flow_no_xsrf_token — WIZ_global_data.SNlM0e is only issued to a signed-in page. Sign in and reload flow.google.com.');
    const u = new URL(BATCH_PATH, location.origin);
    u.searchParams.set('rpcids', rpcid);
    u.searchParams.set('source-path', location.pathname);
    if (tok.bl) u.searchParams.set('bl', tok.bl);
    if (tok.fsid) u.searchParams.set('f.sid', tok.fsid);
    u.searchParams.set('hl', tok.hl);
    u.searchParams.set('_reqid', String(Math.floor(Math.random() * 900000) + 100000));
    u.searchParams.set('rt', 'c');
    const body = new URLSearchParams({ 'f.req': JSON.stringify([[[rpcid, JSON.stringify(inner ?? []), null, 'generic']]]), at: tok.at });
    const res = await A.net.origFetch(u.toString(), {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', 'X-Same-Domain': '1' },
      body: body.toString(),
    });
    const text = await res.text();
    const parsed = parseBatch(text)[rpcid] ?? null;
    return {
      status: res.status,
      rpcid,
      method: RPC_NAMES[rpcid] ?? null,
      ok: res.ok && !!parsed && !parsed.error,
      data: parsed?.data ?? null,
      ...(parsed?.error ? { error: parsed.error } : {}),
      ...(!parsed ? { body: text.slice(0, 600) } : {}),
      ...(raw ? { raw: text.slice(0, 200000) } : {}),
    };
  }

  async function call(name, inner) {
    const id = RPC[name];
    if (!id) throw new Error(`flow_unknown_rpc: ${name}`);
    const r = await rpc(id, inner);
    if (!r.ok) {
      const e = r.error ? `${r.error.status}${r.error.reason ? ' ' + r.error.reason : ''}` : `http_${r.status}`;
      throw new Error(`flow_rpc_failed: ${name} (${id}) -> ${e}`);
    }
    return r.data;
  }

  // ------------------------------------------------------------ read side

  /** GetCredits -> [remaining, ?, ?, ?, null, ?, [seconds, nanos]]. Only [0] is interpreted. */
  async function credits() {
    const d = await call('GetCredits', []);
    return { credits: typeof d?.[0] === 'number' ? d[0] : null, raw: d, timestamp_field: tsIso(d?.[6]) };
  }

  /*
   * GetModels. root[3] = [[key, [display name]]], root[4] = video model groups, root[5] =
   * image model groups. A model entry is [key, null, null, null, [[tier, [[null, credits]]], ...],
   * ...]; for video, index 16 is the clip length (abra_t2v_8s carries 8).
   */
  function decodeModels(d) {
    const root = Array.isArray(d?.[0]) ? d[0] : [];
    const names = new Map((Array.isArray(root[3]) ? root[3] : [])
      .filter((x) => Array.isArray(x) && typeof x[0] === 'string')
      .map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));
    const entries = (node, out = []) => {
      if (!Array.isArray(node)) return out;
      if (typeof node[0] === 'string' && Array.isArray(node[4]) && node[4].every((c) => Array.isArray(c) && typeof c[0] === 'number')) {
        out.push(node);
        return out;
      }
      for (const c of node) entries(c, out);
      return out;
    };
    const shape = (e, kind) => {
      const cost = {};
      for (const c of e[4]) {
        const v = Array.isArray(c[1]) && Array.isArray(c[1][0]) ? c[1][0][1] : null;
        cost['tier' + c[0]] = typeof v === 'number' ? v : null;
      }
      return {
        key: e[0],
        name: names.get(e[0]) ?? null,
        kind,
        credits_by_tier: cost,
        ...(kind === 'video' && typeof e[16] === 'number' ? { duration_s: e[16] } : {}),
      };
    };
    return {
      image: entries(root[5]).map((e) => shape(e, 'image')),
      video: entries(root[4]).map((e) => shape(e, 'video')),
      display_names: Object.fromEntries(names),
    };
  }

  let modelCache = null;
  async function models({ refresh = false } = {}) {
    if (modelCache && !refresh) return modelCache;
    const [m, s] = await Promise.all([
      call('GetModels', []),
      call('ListModelStatuses', []).catch(() => null),
    ]);
    const decoded = decodeModels(m);
    const statuses = {};
    for (const row of (Array.isArray(s?.[0]) ? s[0] : [])) if (Array.isArray(row)) statuses[row[0]] = row[1];
    modelCache = { ...decoded, family_status: statuses, read_at: new Date().toISOString() };
    return modelCache;
  }

  async function projects({ limit = 50 } = {}) {
    const d = await call('GetProjects', ['projects/*', limit, null, null, null, null, [1]]);
    return (Array.isArray(d?.[0]) ? d[0] : []).map((p) => ({
      project_id: p[0],
      title: p[1]?.[0] ?? null,
      updated: tsIso(p[1]?.[2]),
      thumbnail: typeof p[1]?.[3] === 'string' ? p[1][3] : null,
      url: `${location.origin}/project/${p[0]}`,
    }));
  }

  /*
   * GetProjectContents -> [?, workflows[], media[], voices[], …]. Verified 2026-10-01 against a
   * real project (uploads, image generations, abra/veo videos):
   *
   *   workflow  [wfId, null, null, [name, [s,ns], archived, favorited, primaryMediaId, …], projectId]
   *   media     [mediaId, projectId, wfId, "CAE", null, info, details]
   *     info    [[s,ns], title, …, url(5), source(6), …, description(12), bytes(13)]
   *     source  [null, gen, prompt, null, kind] — gen = [[modelKey, …], [[null, k, refMediaId]…]] exists only
   *             on generations; kind is 1 on uploads and new generations alike, 3 on older captioned images
   *             for a generation, prompt = [[null, null, [[[text]]]]]
   *     details image: [null, [.., url(3), 0, null, mime(6)], [w, h]]
   *     details[7] video (and [6] is null): [[null, bytes, …, prompt(7), url(8), …, modelKey(12), …], [null, null, [seconds]], [mediaId]]
   *
   * EVERY media row belongs to a workflow — uploads and generations alike — so "has a workflow"
   * says nothing about where it came from; the source kind does. (The previous version treated
   * workflows as uploads and filtered their media out, which hid 19 of 20 real generations.)
   */
  const deepString = (n) => {
    if (typeof n === 'string') return n;
    if (!Array.isArray(n)) return null;
    for (const x of n) { const s = deepString(x); if (s) return s; }
    return null;
  };

  function mediaOf(e, wf) {
    const info = Array.isArray(e?.[5]) ? e[5] : [];
    const src = Array.isArray(info[6]) ? info[6] : null;
    const gen = src && Array.isArray(src[1]) ? src[1] : null;
    // Videos keep their details at [7] (with [6] null); images keep theirs at [6]. Verified on a real abra_r2v_8s row.
    const video = Array.isArray(e?.[7]?.[0]) ? e[7][0] : null;
    const imageDetails = !video && Array.isArray(e?.[6]?.[1]) ? e[6][1] : null;
    const wm = Array.isArray(wf?.[3]) ? wf[3] : [];
    const dims = !video && Array.isArray(e?.[6]?.[2]) && e[6][2].length === 2 ? { width: e[6][2][0], height: e[6][2][1] } : {};
    const secs = video && Array.isArray(e?.[7]?.[1]?.[2]) ? e[7][1][2][0] : null;
    const url = (video && typeof video[8] === 'string' && video[8]) || (typeof info[5] === 'string' && info[5])
      || (imageDetails && typeof imageDetails[3] === 'string' && imageDetails[3]) || null;
    return {
      media_id: e?.[0] ?? null,
      workflow_id: typeof e?.[2] === 'string' ? e[2] : null,
      // kind is 1 on uploads AND on generations; only a generation carries gen info (model,
      // references). Kind 3 (older images with AI captions) counts as generated.
      source: !gen && src?.[4] === 1 ? 'upload' : 'generated',
      type: video ? 'video' : 'image',
      model: gen?.[0]?.[0] ?? (video && typeof video[12] === 'string' ? video[12] : null),
      references: (gen?.[1] ?? []).map((r) => r?.[2]).filter((x) => typeof x === 'string'),
      prompt: (src && deepString(src[2])) || (video && typeof video[7] === 'string' ? video[7] : null),
      title: typeof info[1] === 'string' ? info[1] : null,
      name: typeof wm[0] === 'string' ? wm[0] : null,
      description: typeof info[12] === 'string' ? info[12] : null,
      created: tsIso(info[0]),
      url,
      mime: imageDetails?.[6] ?? (video ? 'video/mp4' : null),
      bytes: typeof info[13] === 'number' ? info[13] : (video && typeof video[1] === 'number' ? video[1] : null),
      ...dims,
      ...(secs ? { duration_s: secs } : {}),
      archived: !!wm[2],
      favorited: !!wm[3],
    };
  }

  function splitContents(pid, d, { includeTrashed = false } = {}) {
    const wfs = new Map((Array.isArray(d?.[1]) ? d[1] : []).filter((w) => typeof w?.[0] === 'string').map((w) => [w[0], w]));
    const all = (Array.isArray(d?.[2]) ? d[2] : []).map((e) => ({ ...mediaOf(e, wfs.get(e?.[2])), project_id: pid }));
    rememberIds(all);
    const media = includeTrashed ? all : all.filter((m) => !m.archived);
    return {
      project_id: pid,
      media,
      uploads: media.filter((m) => m.source === 'upload'),
      generated: media.filter((m) => m.source === 'generated'),
      trashed: all.filter((m) => m.archived).length,
    };
  }

  /*
   * A 3 s cache of the raw contents per project: back-to-back actions (favorite then trash,
   * save after a wait) each needed a full GetProjectContents just to map ids, ~1 s apiece.
   * Every mutation clears it, and waits bypass it (fresh:true) because they poll for change.
   */
  const contentsCache = new Map();
  const invalidateContents = (pid) => (pid ? contentsCache.delete(pid) : contentsCache.clear());

  async function contents(pid = projectId(), opts = {}) {
    if (!pid) throw new Error('flow_no_project — open or create a project first (flow_open_project / flow_new_project).');
    const hit = contentsCache.get(pid);
    let d;
    if (!opts.fresh && hit && Date.now() - hit.at < 3000) d = hit.d;
    else {
      d = await call('GetProjectContents', [`projects/${pid}`, null, null, null, [1]]);
      contentsCache.set(pid, { at: Date.now(), d });
    }
    return splitContents(pid, d, opts);
  }

  /*
   * media id -> workflow id never changes, so it is remembered from every listing (and every
   * upload reply) for the life of the page. With it, an action on a known item skips the whole
   * GetProjectContents round trip (~1 s) and goes straight to its one RPC.
   */
  const idMap = new Map(); // id (media or workflow) -> { wf, pid }
  function rememberIds(media) {
    for (const m of media) {
      if (!m?.workflow_id) continue;
      const pid = m.project_id ?? projectId();
      idMap.set(m.media_id, { wf: m.workflow_id, pid });
      idMap.set(m.workflow_id, { wf: m.workflow_id, pid });
    }
  }

  /** Media or workflow ids -> the workflow ids Flow's edit RPCs take. */
  async function workflowsFor(ids, pid) {
    const want = [].concat(ids ?? []).map(String);
    const project = pid || projectId();
    const known = want.map((id) => idMap.get(id)).filter((x) => x && (!pid || x.pid === pid));
    if (want.length && known.length === want.length) {
      return { project_id: known[0].pid ?? project, workflows: [...new Set(known.map((x) => x.wf))] };
    }
    const c = await contents(pid, { includeTrashed: true });
    const out = [];
    const missing = [];
    for (const raw of [].concat(ids ?? [])) {
      const id = String(raw);
      const m = c.media.find((x) => x.media_id === id || x.workflow_id === id);
      if (m?.workflow_id) out.push(m.workflow_id); else missing.push(id);
    }
    if (missing.length) throw new Error(`flow_media_not_in_project: ${missing.join(', ')} not in project ${c.project_id}`);
    return { project_id: c.project_id, workflows: [...new Set(out)] };
  }

  // ------------------------------------------------------ settings panel

  const overlay = () => pick(SEL.overlay, { requireVisible: false }).el;
  const panelRadios = () => $$('button[role="radio"]', overlay() || document).filter(visible);
  const panelOpen = () => panelRadios().some((b) => /^(image|video)$/i.test(cleanLabel(b)) || /\b(image|video)$/i.test(cleanLabel(b)));
  const checked = (b) => b.getAttribute('aria-checked') === 'true' || b.getAttribute('aria-pressed') === 'true';

  const GROUPS = {
    mode: (l) => /^(image|video)$/i.test(l),
    video_input: (l) => /^(frames|ingredients)$/i.test(l),
    aspect_ratio: (l) => /^\d+:\d+$/.test(l),
    count: (l) => /^x\d$/i.test(l),
    duration: (l) => /^\d+s$/i.test(l),
    resolution: (l) => /^\d{3,4}p\b/i.test(l),
  };
  const groupOf = (label) => Object.keys(GROUPS).find((g) => GROUPS[g](label)) ?? 'other';
  const radioLabel = (b) => cleanLabel(b).replace(/\s*info$/i, '').trim();

  /*
   * The trigger is a toggle and the panel animates out, so its radios stay in the DOM for a
   * moment after it has been told to close. Clicking the trigger again during that window
   * re-opens it, and the next call then toggles it shut — which is how every other configure
   * call timed out. Both directions therefore wait for the state they asked for.
   */
  async function openPanel() {
    if (panelOpen()) return true;
    const t = pick(SEL.settingsTrigger).el;
    if (!t) throw new Error('flow_settings_not_found — open a project first; the settings live next to its prompt box.');
    for (let attempt = 0; attempt < 2; attempt++) {
      clickEl(t);
      const ok = await waitFor(() => panelOpen(), { timeout: 3000, interval: 40, label: 'settings_panel' }).catch(() => false);
      if (ok) return true;
    }
    throw new Error('flow_settings_panel_did_not_open');
  }

  async function closePanel() {
    if (!panelOpen()) return;
    await closeMenu();
    const shut = await waitFor(() => !panelOpen(), { timeout: 1500, interval: 40, label: 'panel_close' }).catch(() => false);
    if (!shut) {
      const t = pick(SEL.settingsTrigger).el;
      if (t) clickEl(t);
      await waitFor(() => !panelOpen(), { timeout: 1500, interval: 100, label: 'panel_close' }).catch(() => null);
    }
  }

  function readPanel() {
    const state = {};
    const options = {};
    for (const b of panelRadios()) {
      const label = radioLabel(b);
      if (!label) continue;
      const g = groupOf(label);
      (options[g] ||= []).push(label);
      if (checked(b)) state[g] = label;
    }
    const fam = pick(SEL.modelFamily, { root: overlay() || document }).el;
    const cost = /Generating will use\s+([\d,]+)\s+credit/i.exec((overlay() || document.body).innerText || '');
    return {
      state: { ...state, model: fam ? cleanLabel(fam).replace(/\s*arrow_drop_down$/, '').trim() : null },
      options,
      credits_cost: cost ? Number(cost[1].replace(/,/g, '')) : null,
    };
  }

  async function modelMenu() {
    const fam = pick(SEL.modelFamily, { root: overlay() || document }).el;
    if (!fam) throw new Error('flow_model_picker_not_found');
    clickEl(fam);
    const items = await waitFor(() => {
      const els = $$('[role="menuitem"],[role="menuitemradio"],[role="option"]', overlay() || document).filter(visible);
      return els.length ? els : null;
    }, { timeout: 6000, interval: 40, label: 'model_menu' });
    return items;
  }

  async function listModels() {
    const items = await modelMenu();
    const out = items.map((e) => cleanLabel(e)).filter(Boolean);
    await closeMenu();
    await waitFor(() => (!modelMenuOpen() ? true : null), { timeout: 1500, interval: 40, label: 'model_menu_close' }).catch(() => null);
    if (!panelOpen()) await openPanel();
    return out;
  }

  /** "NARWHAL" / "veo_3_1_t2v_fast" / "nano banana pro" -> a label the menu shows. */
  /*
   * Wire keys only partly appear in GetModels' name table (veo_3_1_t2v_fast is absent), and the
   * menu shows family names, so a key falls back to the family it belongs to.
   */
  function familyOfKey(k) {
    const s = String(k).toLowerCase();
    let m = /^veo_(\d)_(\d)_/.exec(s);
    if (m) {
      const tier = /lite/.test(s) ? 'Lite' : /fast/.test(s) ? 'Fast' : 'Quality';
      return `Veo ${m[1]}.${m[2]} - ${tier}`;
    }
    if (/^abra/.test(s)) return 'Omni';
    if (s === 'narwhal') return 'Nano Banana 2';
    if (/^(gem_pix_2|nano_banana_pro)/.test(s)) return 'Nano Banana Pro';
    return null;
  }

  async function modelWanted(value) {
    const v = String(value);
    if (/^[A-Za-z0-9]+(?:_[A-Za-z0-9]+)+$|^[A-Z0-9]{4,}$/.test(v)) {
      const fam = familyOfKey(v);
      if (fam) return fam;
      const m = await models().catch(() => null);
      const name = m?.display_names?.[v];
      if (name) return name;
    }
    return v;
  }

  async function pickModel(value) {
    const want = norm(await modelWanted(value));
    const items = await modelMenu();
    const labels = items.map((e) => cleanLabel(e));
    let i = labels.findIndex((l) => norm(l) === want);
    if (i < 0) i = labels.findIndex((l) => norm(l).endsWith(want));
    if (i < 0) i = labels.findIndex((l) => norm(l).includes(want));
    if (i < 0) {
      await closeMenu();
      throw new Error(`flow_model_not_offered: "${value}" — this mode offers: ${labels.join(' | ')}`);
    }
    clickEl(items[i]);
    // The family button re-labels itself once the choice has taken.
    await waitFor(() => {
      const fam = pick(SEL.modelFamily, { root: overlay() || document }).el;
      return fam && norm(cleanLabel(fam)).includes(norm(labels[i])) ? true : null;
    }, { timeout: 3000, interval: 40, label: 'model_pick' }).catch(() => null);
    if (!panelOpen()) await openPanel();
    return labels[i];
  }

  /** Resolve as soon as the panel shows `value` selected in `group` (mode switches re-render it). */
  async function settleRadio(group, value) {
    await waitFor(() => { const b = radioFor(group, value); return b && checked(b) ? true : null; },
      { timeout: 2500, interval: 30, label: 'radio_' + group }).catch(() => null);
  }
  const modelMenuOpen = () => $$('[role="menuitem"],[role="menuitemradio"],[role="option"]', overlay() || document).filter(visible).length > 0;

  function radioFor(group, value) {
    let want = String(value).trim();
    if (group === 'count' && /^\d$/.test(want)) want = 'x' + want;
    if (group === 'duration' && /^\d+$/.test(want)) want = want + 's';
    if (group === 'resolution' && /^\d+$/.test(want)) want = want + 'p';
    if (group === 'mode' || group === 'video_input') want = want.toLowerCase();
    const cands = panelRadios().filter((b) => groupOf(radioLabel(b)) === group);
    return cands.find((b) => radioLabel(b).toLowerCase() === want.toLowerCase())
      ?? cands.find((b) => radioLabel(b).toLowerCase().startsWith(want.toLowerCase()))
      ?? null;
  }

  /**
   * Set any combination of mode / model / aspect_ratio / count / duration / resolution /
   * video_input through the real panel, then read it back. Mode goes first because it
   * swaps which other options exist.
   */
  async function configure(p = {}) {
    await openPanel();
    try {
      return await configureOpen(p);
    } finally {
      if (p.keep_open !== true) await closePanel();
    }
  }

  async function configureOpen(p) {
    const applied = {};
    const order = ['mode', 'video_input', 'aspect_ratio', 'resolution', 'duration', 'count'];
    const set = async (group, value) => {
      if (value == null || value === '') return;
      const b = radioFor(group, value);
      if (!b) {
        const offered = readPanel().options[group] ?? [];
        throw new Error(`flow_option_not_offered: ${group}="${value}" — offered now: ${offered.join(' | ') || '(none in this mode)'}`);
      }
      // Wait for the panel to report the new selection instead of sleeping a guess.
      if (!checked(b)) { clickEl(b); await settleRadio(group, value); }
      applied[group] = radioLabel(b);
    };
    await set('mode', p.mode);
    if (p.model) applied.model = await pickModel(p.model);
    for (const g of order.slice(1)) await set(g, p[g]);
    const now = readPanel();
    for (const [g, v] of Object.entries(applied)) {
      const got = now.state[g];
      if (got != null && norm(got) !== norm(v)) throw new Error(`flow_option_did_not_stick: ${g} wanted "${v}", panel shows "${got}"`);
    }
    return { applied, ...now };
  }

  // -------------------------------------------------------------- prompt

  async function setPrompt(text) {
    const box = pick(SEL.promptBox).el;
    if (!box) throw new Error('flow_prompt_box_not_found — open a project first.');
    const r = await typeInto(box, String(text), { replace: true });
    const landed = norm(editorText(box)).includes(norm(text).slice(0, 40));
    if (!landed) throw new Error('flow_prompt_not_accepted — the editor did not take the text.');
    return { strategy: r?.strategy ?? null };
  }

  // ------------------------------------------------------ waiting on a click

  const genRecords = (sinceId) => A.net.match({ url: 'batchexecute', ...(sinceId ? { since_id: sinceId } : {}) })
    .filter((r) => { try { return GENERATION_RPCS.has(new URL(r.url, location.href).searchParams.get('rpcids')); } catch { return false; } });

  function appGenerationResult(rec) {
    const id = new URL(rec.url, location.href).searchParams.get('rpcids');
    const parsed = rec.done ? parseBatch(rec.text)[id] : null;
    return { request_id: rec.id, rpc: RPC_NAMES[id] ?? id, done: !!rec.done, http: rec.status, ...(parsed?.error ? { error: parsed.error } : {}) };
  }

  /**
   * Wait for the user's Generate click and for its media to land. The click shows up as the
   * app's own generation RPC in the capture buffer; completion shows up as new entries with a
   * url in GetProjectContents. An app-side error (content filter, quota) is returned as soon
   * as the app's own response carries it.
   */
  async function waitForGeneration(p = {}) {
    const pid = p.project_id || projectId();
    const baseline = new Set(p.baseline_ids ?? (await contents(pid)).generated.map((m) => m.media_id));
    const sinceId = p.since_request_id ?? (A.net.records.length ? A.net.records[A.net.records.length - 1].id : null);
    const expect = Math.max(1, Number(p.expect ?? 1));
    const clickDeadline = Date.now() + (p.click_timeout_ms ?? 600000);
    const deadline = Date.now() + (p.timeout_ms ?? 900000);
    let clicked = null;
    let lastPoll = 0;
    let fresh = [];
    for (;;) {
      const recs = genRecords(sinceId);
      if (recs.length && !clicked) clicked = new Date().toISOString();
      const failed = recs.map(appGenerationResult).find((r) => r.error);
      if (failed) return { ok: false, clicked_at: clicked, error: 'flow_generation_failed', app_response: failed };
      if (!clicked && Date.now() > clickDeadline) {
        return { ok: false, error: 'flow_not_clicked', hint: 'Nothing was generated: the Generate button in the Flow tab was not pressed in time. The prompt and settings are still in place.' };
      }
      if (Date.now() - lastPoll > (clicked ? 1500 : 6000)) {
        lastPoll = Date.now();
        const c = await contents(pid, { fresh: true }).catch(() => null);
        if (c) {
          fresh = c.generated.filter((m) => !baseline.has(m.media_id));
          if (!clicked && fresh.length) clicked = new Date().toISOString();
          const done = fresh.filter((m) => m.url);
          if (done.length >= expect) {
            return { ok: true, project_id: pid, clicked_at: clicked, media: done, app_requests: recs.map(appGenerationResult) };
          }
        }
      }
      if (Date.now() > deadline) {
        return { ok: false, error: 'flow_generation_timeout', clicked_at: clicked, pending: fresh, app_requests: recs.map(appGenerationResult) };
      }
      await sleep(250); // the click check is local (capture buffer); only the contents poll is an RPC
    }
  }

  async function prepare(p = {}, mode) {
    if (!projectId()) throw new Error('flow_no_project — open or create a project first (flow_open_project / flow_new_project).');
    const settings = await configure({ ...p, mode: p.mode ?? mode, keep_open: false });
    const prompt = p.prompt != null ? await setPrompt(p.prompt) : null;
    const count = Number(String(settings.state.count ?? 'x1').replace(/\D/g, '')) || 1;
    return { settings, prompt, count };
  }

  async function generate(p = {}, mode) {
    const before = await contents();
    const sinceId = A.net.records.length ? A.net.records[A.net.records.length - 1].id : null;
    const prep = await prepare(p, mode);
    const base = {
      project_id: projectId(),
      settings: prep.settings.state,
      credits_cost: prep.settings.credits_cost,
      prompt_set: !!prep.prompt,
    };
    if (p.wait === false) {
      return {
        ...base,
        status: 'ready_for_click',
        hint: 'Press Generate (the arrow button) in the Flow tab, then call flow_wait_generation with baseline_ids and since_request_id from this result.',
        baseline_ids: before.generated.map((m) => m.media_id),
        since_request_id: sinceId,
      };
    }
    const result = await waitForGeneration({
      project_id: base.project_id,
      baseline_ids: before.generated.map((m) => m.media_id),
      since_request_id: sinceId,
      expect: prep.count,
      click_timeout_ms: p.click_timeout_ms,
      timeout_ms: p.timeout_ms,
    });
    return { ...base, ...result };
  }

  const HUMAN_GATED = (what) => {
    throw new Error(
      `flow_human_gated: ${what} — Flow only accepts it from a real click in its own UI (it labels extension-minted ` +
      'reCAPTCHA tokens "extension_hijack_detected" and refuses untrusted submits). Do it in the Flow tab; ' +
      'flow_wait_generation / flow_media then pick up the result.'
    );
  };

  // ------------------------------------------------------------------ probe

  function mediaOnPage(limit = 100) {
    const out = [];
    const seen = new Set();
    const add = (url, kind, el) => {
      if (!url || seen.has(url) || /^data:/.test(url)) return;
      seen.add(url);
      out.push({ url, kind, alt: el?.getAttribute?.('alt') ?? null });
    };
    for (const v of $$('video')) { add(v.currentSrc || v.src, 'video', v); for (const s of $$('source', v)) add(s.src, 'video', s); if (v.poster) add(v.poster, 'poster', v); }
    for (const i of $$('img')) if (i.naturalWidth >= 128 && /googleusercontent|flow-content|blob:/.test(i.src)) add(i.src, 'image', i);
    return out.slice(0, limit);
  }

  // =============================================================== handlers

  H['flow.status'] = async () => {
    const r = ready();
    const cr = await credits().catch((e) => ({ error: String(e.message) }));
    const trig = pick(SEL.settingsTrigger).el;
    return {
      site: 'flow',
      url: location.href,
      ready: r,
      signed_in: !signedOut(),
      account: accountLabel(),
      project_id: projectId(),
      build: tokens().bl,
      credits: cr.credits ?? null,
      ...(cr.error ? { credits_error: cr.error } : {}),
      prompt_box: !!pick(SEL.promptBox).el,
      settings_summary: trig ? cleanLabel(trig) : null,
      generation_requests_seen: genRecords().length,
      generation: 'human-gated: the tools set everything up, the user presses Generate',
    };
  };

  H['flow.probe'] = async () => {
    const matched = {};
    const unmatched = [];
    for (const [k, v] of Object.entries(SEL)) {
      const f = pick(v, { all: true, requireVisible: false });
      if (f.els.length) matched[k] = `${f.selector} (${f.els.filter(visible).length}/${f.els.length} visible)`;
      else unmatched.push(k);
    }
    return {
      site: 'flow',
      url: location.href,
      matched,
      unmatched,
      buttons: [...new Set($$('button,[role="button"]').filter(visible).map((b) => b.getAttribute('aria-label') || cleanLabel(b)).filter(Boolean))].slice(0, 80),
      panel: panelOpen() ? readPanel() : null,
      editors: $$('[contenteditable="true"],textarea').filter(visible).map(describe),
    };
  };

  H['flow.observe'] = async (p = {}) => {
    const recs = A.net.match({ url: 'batchexecute' });
    const list = (p.host === 'generation' ? genRecords() : recs).slice(-(p.limit ?? 20));
    return {
      total: recs.length,
      requests: list.map((r) => {
        let id = null; let inner = null;
        try { id = new URL(r.url, location.href).searchParams.get('rpcids'); } catch {}
        try { inner = JSON.parse(new URLSearchParams(r.req_body || '').get('f.req'))[0][0][1]; } catch {}
        const parsed = r.done ? parseBatch(r.text)[id] : null;
        return {
          id: r.id, rpc: id, method: RPC_NAMES[id] ?? null, status: r.status, done: !!r.done,
          request: p.body ? inner : String(inner ?? '').slice(0, 200),
          ...(parsed?.error ? { error: parsed.error } : {}),
          ...(p.body && parsed?.data !== undefined ? { response: parsed.data } : {}),
        };
      }),
    };
  };

  H['flow.rpc'] = async (p = {}) => {
    if (!p.rpc && !p.method) {
      return { methods: RPC_NAMES, hint: 'Pass rpc (an id) or method (e.g. "GetCredits") plus inner (the JSPB array payload).' };
    }
    const id = p.rpc ?? RPC[String(p.method).split('.').pop()];
    if (!id) throw new Error(`flow_unknown_rpc: ${p.method ?? p.rpc}`);
    if (TOKEN_GATED.has(id)) HUMAN_GATED(`${RPC_NAMES[id]} needs a reCAPTCHA token`);
    // Flow has no undo; the typed tools never delete, and this escape hatch does not either.
    if (/\.(Batch)?(Delete|Trash|Unshare|Remove)/.test(RPC_NAMES[id] ?? '') && !p.allow_delete) {
      throw new Error(`flow_rpc_refuses_delete: ${RPC_NAMES[id]} — delete in the Flow UI, or pass allow_delete:true if the user explicitly asked for it.`);
    }
    return await rpc(id, p.inner ?? [], { raw: !!p.raw });
  };

  H['flow.credits'] = async () => credits();

  H['flow.models'] = async (p = {}) => {
    const m = await models({ refresh: !!p.refresh });
    return {
      image: m.image,
      video: p.all_video ? m.video : m.video.filter((v) => !/_(ultra|relaxed|low_priority)(_|$)/.test(v.key) && !/^veo_2|^veo_3_0/.test(v.key)),
      ...(p.all_video ? {} : { video_note: 'Legacy (Veo 2/3.0), Ultra-tier and relaxed/low-priority keys are hidden; pass all_video:true to list all ' + m.video.length + '.' }),
      family_status: m.family_status,
      ui_hint: 'flow_options lists exactly what the settings panel offers right now; flow_configure selects by those labels or by key.',
    };
  };

  H['flow.config'] = async () => {
    const [cfg, settings] = await Promise.all([
      call('GetFlowAppConfig', []).catch((e) => ({ error: String(e.message) })),
      call('GetUserSettings', []).catch((e) => ({ error: String(e.message) })),
    ]);
    return { app_config: JSON.stringify(cfg).slice(0, 6000), user_settings: settings };
  };

  H['flow.projects'] = async (p = {}) => ({ projects: await projects({ limit: p.limit ?? 50 }) });

  H['flow.project'] = async (p = {}) => contents(p.project_id);

  H['flow.open_project'] = async (p = {}) => {
    let id = p.project_id ?? null;
    if (!id && (p.title != null || p.index != null)) {
      const list = await projects();
      const hit = p.title != null
        ? list.find((x) => norm(x.title) === norm(p.title)) ?? list.find((x) => norm(x.title).includes(norm(p.title)))
        : list[Number(p.index)];
      if (!hit) throw new Error(`flow_project_not_found — have: ${list.map((x) => x.title).slice(0, 20).join(' | ')}`);
      id = hit.project_id;
    }
    if (!id) throw new Error('project_id, title or index required');
    if (projectId() === id) return { ok: true, project_id: id, url: location.href, already_open: true };
    return { ok: false, needs_navigation: true, url: `${location.origin}/project/${id}` };
  };

  H['flow.new_project'] = async () => {
    const btn = findByText('New project', 'button,a,[role="button"]');
    if (!btn) return { ok: false, needs_navigation: true, url: location.origin + '/', hint: 'The "New project" button lives on the Flow home page.' };
    const before = location.pathname;
    clickEl(btn);
    await waitFor(() => location.pathname !== before && projectId(), { timeout: 30000, interval: 100, label: 'new_project' });
    await waitFor(() => pick(SEL.promptBox).el, { timeout: 30000, interval: 100, label: 'prompt_box' }).catch(() => null);
    return { ok: true, project_id: projectId(), url: location.href };
  };

  H['flow.options'] = async () => {
    await openPanel();
    const first = readPanel();
    const out = { current: first.state, credits_cost: first.credits_cost, modes: {} };
    const startMode = first.state.mode;
    for (const mode of ['Image', 'Video']) {
      const b = radioFor('mode', mode);
      if (b && !checked(b)) { clickEl(b); await settleRadio('mode', mode); }
      const now = readPanel();
      const { mode: _m, ...rest } = now.options;
      out.modes[mode.toLowerCase()] = { ...rest, model: await listModels().catch((e) => [String(e.message)]) };
    }
    if (startMode) { const b = radioFor('mode', startMode); if (b && !checked(b)) { clickEl(b); await settleRadio('mode', startMode); } }
    await closePanel();
    return out;
  };

  H['flow.configure'] = async (p = {}) => configure(p);

  H['flow.set_option'] = async (p = {}) => {
    if (!p.label) throw new Error('label_required — the visible text of the option, e.g. "9:16", "x2", "8s", "Veo 3.1 - Fast"');
    await openPanel();
    const g = groupOf(String(p.label).trim());
    if (g !== 'other' || /^(image|video|frames|ingredients)$/i.test(String(p.label).trim())) {
      return configure({ [g === 'other' ? 'mode' : g]: p.label });
    }
    return configure({ model: p.label });
  };

  H['flow.set_prompt'] = async (p = {}) => ({ ok: true, ...(await setPrompt(p.prompt ?? p.text ?? '')) });

  H['flow.generate'] = async (p = {}) => generate(p, p.mode);
  H['flow.generate_image'] = async (p = {}) => generate({ ...p, count: p.count }, 'Image');
  H['flow.generate_video'] = async (p = {}) => generate({ ...p, count: p.count }, 'Video');
  H['flow.wait_generation'] = async (p = {}) => waitForGeneration(p);
  H['flow.poll_video'] = async (p = {}) => waitForGeneration({ ...p, click_timeout_ms: p.click_timeout_ms ?? 1000 });

  H['flow.generate_api'] = async () => HUMAN_GATED('API generation');
  H['flow.upscale_image'] = async () => HUMAN_GATED('upscaling (use the tile\'s download menu: 1K original / 2K upscaled)');
  H['flow.upload_image'] = async () => HUMAN_GATED('API uploads (UploadImage mints an UPLOAD_IMAGE token)');

  H['flow.media'] = async (p = {}) => {
    const c = projectId() ? await contents().catch((e) => ({ error: String(e.message) })) : null;
    return {
      project_id: projectId(),
      generated: c?.generated?.slice(-(p.limit ?? 50)) ?? [],
      uploads: c?.uploads?.slice(-(p.limit ?? 50)) ?? [],
      ...(c?.trashed ? { trashed: c.trashed } : {}),
      ...(c?.error ? { error: c.error } : {}),
      hint: 'flow_save downloads any of these at full resolution.',
    };
  };

  H['flow.media_url'] = async (p = {}) => {
    if (!p.media_id) throw new Error('media_id_required');
    const c = await contents(p.project_id);
    const hit = c.media.find((m) => m.media_id === p.media_id || m.workflow_id === p.media_id);
    if (!hit) throw new Error(`flow_media_not_in_project: ${p.media_id} is not in project ${c.project_id}`);
    return { media_id: hit.media_id, url: hit.url, type: hit.type, mime: hit.mime };
  };

  H['flow.scenes'] = async () => {
    const c = await contents();
    const byWorkflow = {};
    for (const m of c.generated) (byWorkflow[m.workflow_id ?? 'none'] ||= []).push(m);
    return { project_id: c.project_id, workflows: Object.entries(byWorkflow).map(([id, media]) => ({ workflow_id: id, count: media.length, media })) };
  };

  /*
   * Uploads are DROPPED onto the project, the same gesture as dragging a file in by hand;
   * the app then uploads it through its own UploadImage path with its own token. The menu's
   * "Upload" item cannot be used: it opens a native file chooser, which browsers only allow
   * under real user activation, so a synthetic click does nothing at all (verified
   * 2026-09-30: no input, no picker call). The drop was verified the same day — the app
   * issued maseQ (UploadImage) and the file appeared in GetProjectContents.
   */
  H['flow.upload'] = async (p = {}) => {
    if (!p.base64) throw new Error('base64_required');
    if (!projectId()) throw new Error('flow_no_project — open a project first.');
    const name = String(p.filename || 'upload.png');
    const mime = String(p.mimetype || 'image/png');
    const bin = atob(String(p.base64));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const file = new File([bytes], name, { type: mime });
    const before = (await contents()).uploads.map((m) => m.media_id);
    const sinceUp = A.net.records.length ? A.net.records[A.net.records.length - 1].id : null;

    await closeMenu();
    const area = $$('main, [role="main"], .content-contain').find(visible) ?? document.body;
    const r = area.getBoundingClientRect();
    const at = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, cancelable: true, composed: true };
    const target = document.elementFromPoint(at.clientX, at.clientY) ?? area;
    let accepted = false;
    for (const type of ['dragenter', 'dragover', 'drop']) {
      const dt = new DataTransfer();
      dt.items.add(file);
      const notCanceled = target.dispatchEvent(new DragEvent(type, { ...at, dataTransfer: dt }));
      if (type === 'drop') accepted = !notCanceled; // the app calls preventDefault when it takes the drop
      await sleep(30);
    }
    if (!accepted) {
      return { ok: false, error: 'flow_drop_not_handled', hint: 'The project did not take the dropped file. Drag it in by hand; flow_media lists it afterwards.' };
    }
    /*
     * Fast path: the app's own UploadImage (maseQ) reply already carries the new media and
     * workflow rows (measured 7.5 s after the drop), while the project listing only shows it
     * several seconds later (the old wait took ~15 s). Fall back to the listing only when no
     * such reply shows up.
     */
    const upRec = await waitFor(() => A.net.match({ url: 'rpcids=' + RPC.UploadImage, ...(sinceUp ? { since_id: sinceUp } : {}) }).find((r) => r.done) || null,
      { timeout: Math.min(p.timeout_ms ?? 45000, 40000), interval: 100, label: 'upload_rpc' }).catch(() => null);
    if (upRec) {
      const parsed = parseBatch(upRec.text)[RPC.UploadImage];
      if (parsed?.error) return { ok: false, error: 'flow_upload_rejected', app_response: parsed.error };
      const d = parsed?.data;
      if (Array.isArray(d?.[0]) && typeof d[0][0] === 'string') {
        const m = mediaOf(d[0], Array.isArray(d[1]) ? d[1] : null);
        rememberIds([m]);
        invalidateContents(projectId());
        return { ok: true, filename: name, bytes: file.size, media: [m], via: 'upload_rpc' };
      }
    }
    const landed = await waitFor(async () => {
      const now = (await contents(undefined, { fresh: true })).uploads.filter((m) => !before.includes(m.media_id));
      return now.length ? now : null;
    }, { timeout: p.timeout_ms ?? 45000, interval: 600, label: 'upload' }).catch(() => null);
    if (!landed) {
      return { ok: false, error: 'flow_upload_not_accepted', hint: 'The file was placed in the input but Flow did not upload it. Drag the file into the project by hand; flow_media lists it afterwards.' };
    }
    return { ok: true, filename: name, bytes: file.size, media: landed };
  };

  /* ------------------------ direct actions (one RPC, no menus) ------------------------
   * Captured from the app's own requests on 2026-10-01 (test project only):
   *   favorite  mYWVGd UpdateWorkflow       [[wf,null,null,[null,null,null,bool],pid],[["metadata.favorited"]]]
   *   rename    mYWVGd UpdateWorkflow       [[wf,null,null,[name],pid],[["metadata.display_name"]]]
   *   trash     pGCYOe BatchUpdateWorkflows [[[wf,null,null,[null,null,bool],pid]…],[["metadata.archived"]]]
   *   project   o8DA4  UpdateProjectInfo    ["projects/<id>",[title],[["project_title"]],[null,22]]
   * From the bundle's request builders:
   *   create    jHPbke CreateProject        ["projects/*",[null,[title]],[null,22]]
   *   delete    QI2zvc DeleteProject        ["projects/<id>"]
   *   purge     cz8Z4b BatchDeleteAssets    [[wf…],null,"<pid>"]   (permanent; the server gates it)
   * Trash is Flow's own recoverable bin (the project's /trash view); restore reverses it.
   */
  const CTX = [null, 22];

  H['flow.favorite'] = async (p = {}) => {
    const { project_id, workflows } = await workflowsFor(p.ids ?? p.media_ids ?? p.media_id, p.project_id);
    const value = p.value !== false;
    for (const wf of workflows) await call('UpdateWorkflow', [[wf, null, null, [null, null, null, value], project_id], [['metadata.favorited']]]);
    invalidateContents(project_id);
    return { ok: true, favorited: value, workflows };
  };

  const setArchived = async (p, archived) => {
    const { project_id, workflows } = await workflowsFor(p.ids ?? p.media_ids ?? p.media_id, p.project_id);
    await call('BatchUpdateWorkflows', [workflows.map((wf) => [wf, null, null, [null, null, archived], project_id]), [['metadata.archived']]]);
    invalidateContents(project_id);
    return { ok: true, [archived ? 'trashed' : 'restored']: workflows.length, workflows };
  };
  H['flow.trash'] = async (p = {}) => setArchived(p, true);
  H['flow.restore'] = async (p = {}) => setArchived(p, false);

  H['flow.rename_media'] = async (p = {}) => {
    if (!p.name) throw new Error('name_required');
    const { project_id, workflows } = await workflowsFor(p.id ?? p.media_id, p.project_id);
    await call('UpdateWorkflow', [[workflows[0], null, null, [String(p.name)], project_id], [['metadata.display_name']]]);
    invalidateContents(project_id);
    return { ok: true, workflow_id: workflows[0], name: String(p.name) };
  };

  H['flow.rename_project'] = async (p = {}) => {
    const pid = p.project_id || projectId();
    if (!pid || !p.title) throw new Error('project_id_and_title_required');
    await call('UpdateProjectInfo', [`projects/${pid}`, [String(p.title)], [['project_title']], CTX]);
    return { ok: true, project_id: pid, title: String(p.title) };
  };

  H['flow.create_project'] = async (p = {}) => {
    const title = String(p.title || new Date().toISOString().slice(0, 16).replace('T', ' '));
    const d = await call('CreateProject', ['projects/*', [null, [title]], CTX]);
    const id = deepString(d)?.replace(/^projects\//, '') ?? null;
    if (!id || !/^[0-9a-f-]{36}$/.test(id)) throw new Error('flow_create_project_unexpected_reply: ' + JSON.stringify(d).slice(0, 200));
    return { ok: true, project_id: id, title, url: `${location.origin}/project/${id}` };
  };

  // Both deletes run only when the server says so (it checks the bridge's own ledger or the
  // operator's AI_MCP_ALLOW_DELETE); called directly they refuse.
  H['flow.delete_project'] = async (p = {}) => {
    if (p.__server_authorised !== true) throw new Error('flow_delete_needs_server_authorisation — use the flow_delete_project tool');
    if (!p.project_id) throw new Error('project_id_required');
    await call('DeleteProject', [`projects/${p.project_id}`]);
    const still = (await projects({ limit: 100 })).some((x) => x.project_id === p.project_id);
    return { ok: !still, project_id: p.project_id, deleted: !still, was_open: projectId() === p.project_id };
  };

  H['flow.delete_media'] = async (p = {}) => {
    if (p.__server_authorised !== true) throw new Error('flow_delete_needs_server_authorisation — use the flow_delete_media tool');
    const { project_id, workflows } = await workflowsFor(p.ids ?? p.media_ids ?? p.media_id, p.project_id);
    await call('BatchDeleteAssets', [workflows, null, project_id]);
    invalidateContents(project_id);
    const left = (await contents(project_id, { includeTrashed: true })).media.filter((m) => workflows.includes(m.workflow_id)).length;
    return { ok: left === 0, deleted: workflows.length - left, workflows };
  };

  /** Everything flow_save needs: url, type and a file name, for ids or for "new since". */
  H['flow.media_urls'] = async (p = {}) => {
    const c = await contents(p.project_id, { includeTrashed: !!p.include_trashed });
    let list = c.media;
    if (p.ids?.length) list = list.filter((m) => p.ids.includes(m.media_id) || p.ids.includes(m.workflow_id));
    else if (p.baseline_ids) list = list.filter((m) => !p.baseline_ids.includes(m.media_id));
    else if (p.source) list = list.filter((m) => m.source === p.source);
    if (p.limit) list = list.slice(-p.limit);
    return {
      project_id: c.project_id,
      items: list.map((m) => ({
        media_id: m.media_id, type: m.type, mime: m.mime, url: m.url,
        name: (m.name || m.title || m.prompt || m.media_id).replace(/[\\/:*?"<>|\n\r\t]+/g, ' ').replace(/\.(png|jpe?g|webp|gif|mp4)$/i, '').trim().slice(0, 60) || m.media_id,
      })),
    };
  };

  /** Generations across projects, newest projects first — what was made, with which model and prompt. */
  H['flow.history'] = async (p = {}) => {
    const list = (await projects({ limit: p.projects ?? 10 })).slice(0, p.projects ?? 10);
    const out = [];
    for (const pr of list) {
      const c = await contents(pr.project_id).catch(() => null);
      if (!c) continue;
      for (const m of c.generated) {
        out.push({ project_id: pr.project_id, project: pr.title, media_id: m.media_id, type: m.type, model: m.model, prompt: m.prompt ? m.prompt.slice(0, p.prompt_chars ?? 300) : null, title: m.title, created: m.created, url: m.url, favorited: m.favorited || undefined });
      }
    }
    out.sort((a, b) => String(b.created).localeCompare(String(a.created)));
    return { count: out.length, generations: out.slice(0, p.limit ?? 100) };
  };

  H['flow.trash_list'] = async (p = {}) => {
    const c = await contents(p.project_id, { includeTrashed: true });
    return { project_id: c.project_id, trashed: c.media.filter((m) => m.archived) };
  };

  H['flow.characters'] = async () => ({ likenesses: await call('ListUserLikenesses', [1]).catch((e) => ({ error: String(e.message) })) });

  H['flow.trpc'] = async () => {
    throw new Error('flow_trpc_retired — Flow moved to flow.google.com in Sep 2026 and no longer has tRPC. Use flow_rpc (batchexecute) instead; call it with no arguments for the method table.');
  };

  H['flow.api'] = async (p = {}) => {
    if (!p.url) throw new Error('url_required');
    if (/aisandbox-pa\.googleapis\.com/.test(String(p.url))) HUMAN_GATED('direct generation-backend calls');
    return await H['net.request']({ ...p });
  };

  // ---------------------------------------------------------------- selftest

  async function selftest() {
    const out = [];
    const t = (name, cond, detail) => out.push({ name, pass: !!cond, ...(detail !== undefined && !cond ? { detail } : {}) });

    t('flow_module_registered', A.site?.id === 'flow');
    t('flow_handlers_present', ['flow.status', 'flow.rpc', 'flow.models', 'flow.projects', 'flow.options', 'flow.configure', 'flow.generate', 'flow.wait_generation', 'flow.media']
      .every((k) => typeof H[k] === 'function'));
    t('flow_rpc_table_has_core_methods', ['GetCredits', 'GetModels', 'GetProjects', 'GetProjectContents', 'BatchGenerateImages'].every((n) => !!RPC[n]));

    // Account safety: nothing token-gated may be callable through flow_rpc.
    t('token_gated_rpcs_include_image_generation', TOKEN_GATED.has(RPC.BatchGenerateImages));
    t('token_gated_rpcs_include_video_generation', TOKEN_GATED.has(RPC.BatchAsyncGenerateVideoText));
    t('token_gated_rpcs_include_upload', TOKEN_GATED.has(RPC.UploadImage));
    let refused = false;
    try { await H['flow.rpc']({ method: 'BatchGenerateImages', inner: [] }); } catch (e) { refused = /human_gated/.test(String(e.message)); }
    t('flow_rpc_refuses_generation', refused);
    t('no_handler_touches_the_recaptcha_api', !Object.entries(H).some(([k, f]) => k.startsWith('flow.') && /grecaptcha|\.execute\(/.test(String(f))));

    // batchexecute envelope — the piece that would silently return nothing.
    const env = (rows) => ")]}'\n\n" + JSON.stringify(rows).length + '\n' + JSON.stringify(rows) + '\n';
    const ok = parseBatch(env([['wrb.fr', 'nzlxg', '[1050,1]', null, null, null, 'generic']]));
    t('batch_parses_data', ok.nzlxg?.data?.[0] === 1050, ok);
    const bad = parseBatch(env([['wrb.fr', 'ogiZ0b', null, null, null, [7, [['type.googleapis.com/google.rpc.ErrorInfo', ['PUBLIC_ERROR_UNUSUAL_ACTIVITY']]]], 'generic']]));
    t('batch_parses_error_code', bad.ogiZ0b?.error?.status === 'PERMISSION_DENIED', bad);
    t('batch_parses_error_reason', bad.ogiZ0b?.error?.reason === 'PUBLIC_ERROR_UNUSUAL_ACTIVITY', bad);
    t('batch_on_garbage_is_empty', Object.keys(parseBatch('nonsense')).length === 0);

    // GetModels decoding, against the observed shape.
    const synth = [[null, null, [], [['NARWHAL', ['Nano Banana 2']], ['veo_3_1_t2v_fast', ['Veo 3.1 - Fast']]],
      [[null, [['veo_3_1_t2v_fast', null, null, null, [[1, [[null, 20]]], [2, [[null, 20]]], [3, [null, []]]], null, null, null, null, null, true, null, null, null, 100, null, 8]]]],
      [[null, [['NARWHAL', null, null, null, [[1, [[null, 0]]], [2, [[null, 0]]], [3, [[null, 0]]]]]]]]]];
    const dm = decodeModels(synth);
    t('models_decode_image', dm.image[0]?.key === 'NARWHAL' && dm.image[0]?.name === 'Nano Banana 2', dm);
    t('models_decode_image_cost', dm.image[0]?.credits_by_tier?.tier1 === 0, dm);
    t('models_decode_video_cost', dm.video[0]?.credits_by_tier?.tier1 === 20 && dm.video[0]?.credits_by_tier?.tier3 === null, dm);
    t('models_decode_video_duration', dm.video[0]?.duration_s === 8, dm);

    // GetProjectContents rows, against the shapes observed 2026-10-01.
    const upRow = ['m-up', 'p1', 'w-up', 'CAE', null, [[1790784429, 0], null, null, null, null, 'https://lh3.googleusercontent.com/asb/u', [null, null, null, null, 1], null, null, 1, 'https://lh3.googleusercontent.com/asb/u', null, null, 1226], [null, [null, null, null, 'https://lh3.googleusercontent.com/asb/u', 0, null, 'image/jpeg'], [96, 96]]];
    const genRow = ['m-gen', 'p1', 'w-gen', 'CAE', null, [[1787667398, 0], 'Home office', null, null, null, 'https://lh3.googleusercontent.com/asb/g', [null, [['NARWHAL', 3, [5], null, 2, 1], [[null, 4, 'm-up']]], [[null, null, [[['A tidy home office']]]]], null, 1], null, [3], 1, 'https://lh3.googleusercontent.com/asb/g', null, 'A tidy home office with a desk', 493932], [null, [null, null, null, 'https://lh3.googleusercontent.com/asb/g', 0], [2016, 1512]]];
    const vidRow = ['m-vid', 'p1', 'w-vid', 'CAE', null, [[1789742472, 0], 'Motion', null, null, null, 'https://lh3.googleusercontent.com/asb/poster', [null, [['abra_r2v_8s', 3, [5], null, 2, 1], []], [[null, null, [[['animate it']]]]], null, 1]], null, [[null, 814754, null, null, null, null, null, 'animate it', 'https://lh3.googleusercontent.com/asb/v', null, null, null, 'abra_r2v_8s'], [null, null, [8]], ['m-vid']]];
    const wfRows = [['w-up', null, null, ['a.png', [1790784429, 0], true, null, 'm-up'], 'p1'], ['w-gen', null, null, ['Home office', [1787667398, 0], null, true, 'm-gen'], 'p1'], ['w-vid', null, null, ['Motion', [1789742472, 0], null, null, 'm-vid'], 'p1']];
    const wmap = new Map(wfRows.map((w) => [w[0], w]));
    const mu = mediaOf(upRow, wmap.get('w-up'));
    const mg = mediaOf(genRow, wmap.get('w-gen'));
    const mv = mediaOf(vidRow, wmap.get('w-vid'));
    t('media_upload_kind', mu.source === 'upload' && mu.name === 'a.png' && mu.archived === true, mu);
    t('media_generation_kind', mg.source === 'generated' && mg.model === 'NARWHAL' && mg.references[0] === 'm-up', mg);
    t('media_generation_prompt', mg.prompt === 'A tidy home office' && mg.favorited === true, mg);
    t('media_generation_dims', mg.width === 2016 && mg.height === 1512 && mg.created === '2026-08-25T14:16:38.000Z', mg);
    t('media_video_details', mv.type === 'video' && mv.url === 'https://lh3.googleusercontent.com/asb/v' && mv.duration_s === 8 && mv.model === 'abra_r2v_8s', mv);

    // Every media row has a workflow; the source kind, not the workflow, decides upload vs generated.
    const sc = splitContents('p1', [null, wfRows, [upRow, genRow, vidRow]]);
    t('contents_keeps_generations_with_workflows', sc.generated.map((m) => m.media_id).join() === 'm-gen,m-vid', sc.generated);
    t('contents_hides_trashed_by_default', sc.uploads.length === 0 && sc.trashed === 1, sc);
    t('contents_can_include_trashed', splitContents('p1', [null, wfRows, [upRow, genRow]], { includeTrashed: true }).uploads.length === 1);

    // Option grouping and matching.
    t('group_aspect', groupOf('16:9') === 'aspect_ratio' && groupOf('9:16') === 'aspect_ratio');
    t('group_count', groupOf('x3') === 'count');
    t('group_duration', groupOf('10s') === 'duration');
    t('group_resolution', groupOf('720p') === 'resolution');
    t('group_mode', groupOf('Video') === 'mode' && groupOf('Frames') === 'video_input');
    t('norm_strips_emoji', norm('🍌 Nano Banana 2') === 'nano banana 2', norm('🍌 Nano Banana 2'));
    const host = el('button', { role: 'radio', style: 'position:fixed;left:-10000px' }, el('mat-icon', {}, 'crop_16_9'), el('span', {}, '16:9'));
    document.body.appendChild(host);
    try { t('clean_label_drops_ligature', cleanLabel(host) === '16:9', cleanLabel(host)); } finally { host.remove(); }

    t('key_maps_to_veo_family', familyOfKey('veo_3_1_t2v_fast') === 'Veo 3.1 - Fast' && familyOfKey('veo_3_1_t2v_lite') === 'Veo 3.1 - Lite' && familyOfKey('veo_3_1_quality') === 'Veo 3.1 - Quality');
    t('key_maps_to_image_family', familyOfKey('NARWHAL') === 'Nano Banana 2' && familyOfKey('GEM_PIX_2') === 'Nano Banana Pro' && familyOfKey('abra_t2v_8s') === 'Omni');
    t('project_id_parsed', /\/project\/([\w-]+)/i.exec('/project/ab12-cd34')?.[1] === 'ab12-cd34');
    t('labs_path_still_recognised', FLOW_PATH.test('/fx/tools/flow'));

    const r = ready();
    t('ready_reports_a_known_state', ['app', 'signed_out', 'loading', 'not_on_flow', 'app_shell_only'].includes(r.state), r);
    return out;
  }

  // ------------------------------------------------------------------ export

  A.site = {
    id: 'flow',
    version: SITE_VERSION,
    selectors: SEL,
    ready,
    selftest,
    status: async () => ({ project_id: projectId(), on_flow: onFlow(), signed_in: !signedOut(), videos: $$('video').length }),
  };

  A.log(`flow module v${SITE_VERSION} installed`);
})();
