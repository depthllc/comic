(function () {
  const state = {
    user: null,
    projects: [],
    currentProjectId: null,
    view: "overview",
    screen: "home",
    authMode: "register",
    draft: null,
    previewArc: 0,
    previewResult: "",
    engineMode: "world"
  };

  const app = document.getElementById("app");
  const accountActions = document.getElementById("account-actions");
  const toast = document.getElementById("toast");
  const motion = {
    canvasReady: false,
    cinematicCanvas: null,
    cinematicFrame: null,
    engineCanvas: null,
    engineFrame: null,
    proofFrames: [],
    enginePointer: { x: 0.5, y: 0.5 },
    observer: null,
    videoObserver: null,
    videoWarmObserver: null,
    videoResizeHandler: null,
    videoFrame: null,
    modelObserver: null,
    statusTimer: null,
    engineCycleTimer: null,
    parallaxHandler: null,
    parallaxFrame: null,
    buildIndex: 0
  };

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function money(value) {
    const number = Number(value || 0);
    return number.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }

  function engineModeLabel(mode) {
    return {
      world: "World Composer",
      story: "Narrative Graph",
      character: "Character Rig Lab",
      economy: "Wallet Economy",
      build: "Mobile Build Line"
    }[mode] || "World Composer";
  }

  function engineModeDescription(mode) {
    return {
      world: "Terrain, lighting, quests, enemies, camera beats, and player goals form together as editable game data.",
      story: "Branching choices, factions, consequences, and cinematic triggers become a playable narrative graph.",
      character: "Heroes, rivals, ability kits, motives, and rig notes become a cast system instead of loose bios.",
      economy: "Rewards, IAP grants, wallet ledger events, sinks, and fraud checks are modeled before launch.",
      build: "The creator project is packaged into mobile export tasks, store notes, backend contracts, and QA gates."
    }[mode] || "Terrain, lighting, quests, enemies, camera beats, and player goals form together as editable game data.";
  }

  function engineModeFeed(mode) {
    return {
      world: ["terrain.mesh generated", "quest markers placed", "lighting pass active"],
      story: ["choice graph expanded", "faction pressure simulated", "ending state linked"],
      character: ["companion rig mapped", "ability tree compiled", "dialogue memory seeded"],
      economy: ["wallet ledger balanced", "IAP grants tested", "reward sinks tuned"],
      build: ["ios target bundled", "android target bundled", "store checklist generated"]
    }[mode] || ["terrain.mesh generated", "quest markers placed", "lighting pass active"];
  }

  const engineModeSequence = ["world", "story", "character", "economy", "build"];

  function engineModeStatus(mode) {
    return {
      world: "Building",
      story: "Writing",
      character: "Casting",
      economy: "Balancing",
      build: "Exporting"
    }[mode] || "Building";
  }

  function setEngineMode(mode, options = {}) {
    const nextMode = engineModeSequence.includes(mode) ? mode : "world";
    state.engineMode = nextMode;
    const consoles = document.querySelectorAll(".live-console");

    if (options.animate) {
      consoles.forEach((consolePanel) => consolePanel.classList.add("is-changing"));
    }

    window.setTimeout(() => {
      document.querySelectorAll("[data-engine-mode]").forEach((button) => {
        button.classList.toggle("active", button.dataset.engineMode === state.engineMode);
      });
      document.querySelectorAll("[data-engine-view-mode]").forEach((viewport) => {
        viewport.dataset.engineViewMode = state.engineMode;
      });
      document.querySelectorAll("[data-engine-mode-label]").forEach((label) => {
        label.textContent = engineModeLabel(state.engineMode);
      });
      document.querySelectorAll("[data-engine-mode-copy]").forEach((copy) => {
        copy.textContent = engineModeDescription(state.engineMode);
      });
      document.querySelectorAll("[data-engine-mode-feed]").forEach((feed) => {
        feed.innerHTML = engineModeFeed(state.engineMode).map((line) => `<span>${escapeHtml(line)}</span>`).join("");
      });
      document.querySelectorAll("[data-live-status]").forEach((node) => {
        node.textContent = engineModeStatus(state.engineMode);
      });
      consoles.forEach((consolePanel) => consolePanel.classList.remove("is-changing"));
    }, options.animate ? 160 : 0);

    if (options.announce) {
      showToast(`${engineModeLabel(state.engineMode)} loaded.`);
    }
  }

  function projectReadiness(project) {
    const checks = [
      project.story?.length > 1,
      project.characters?.length > 1,
      project.worlds?.length > 0,
      project.terrain?.length > 0,
      project.economy?.iapProducts?.length > 0,
      project.economy?.rewards?.length > 0,
      project.buildJobs?.length > 0,
      project.builds?.length > 0
    ];
    const passed = checks.filter(Boolean).length;
    return Math.round((passed / checks.length) * 100);
  }

  function pipelineSteps(project) {
    return [
      {
        id: "brief",
        title: "Game Brief",
        view: "studio",
        module: "story",
        done: Boolean(project.design?.premise && project.design?.gameplayLoop),
        metric: project.design?.engineTrack || "Runtime scaffold",
        prompt: `Create a production-ready game brief for ${project.title}: premise, gameplay loop, player promise, core pillars, onboarding mission, and retention loop.`
      },
      {
        id: "story",
        title: "Story Graph",
        view: "agent",
        module: "story",
        done: (project.story || []).length >= 3,
        metric: `${(project.story || []).length} arcs`,
        prompt: `Expand ${project.title} into a branching story graph with quests, choices, consequences, dialogue memory, factions, and ending states.`
      },
      {
        id: "cast",
        title: "Playable Cast",
        view: "studio",
        module: "character",
        done: (project.characters || []).length >= 3,
        metric: `${(project.characters || []).length} characters`,
        prompt: `Create playable heroes, enemies, companions, ability kits, motives, rig notes, and boss behavior for ${project.title}.`
      },
      {
        id: "world",
        title: "World + Terrain",
        view: "agent",
        module: "world",
        done: (project.terrain || []).length >= 2,
        metric: `${(project.terrain || []).length} zones`,
        prompt: `Generate AAA mobile terrain zones, maps, biomes, mission objectives, enemy spawn rules, lighting, reward paths, and points of interest for ${project.title}.`
      },
      {
        id: "economy",
        title: "Wallet Economy",
        view: "economy",
        module: "economy",
        done: (project.economy?.iapProducts || []).length >= 3 && (project.economy?.rewards || []).length >= 3,
        metric: `${(project.economy?.iapProducts || []).length} IAP SKUs`,
        prompt: `Tune the ${project.economy?.currencySymbol || "C30"} reward economy, IAP products, sinks, fraud checks, wallet ledger events, and store review guardrails for ${project.title}.`
      },
      {
        id: "package",
        title: "Package Builds",
        view: "builds",
        module: "build",
        done: (project.buildJobs || []).length > 0,
        metric: `${(project.buildJobs || []).length} jobs`,
        prompt: `Package ${project.title} into Android and iOS native scaffold builds with engine payload, story, characters, terrain, economy config, and build notes.`
      },
      {
        id: "deploy",
        title: "Deploy + Operate",
        view: "deploy",
        module: "build",
        done: (project.builds || []).length > 0,
        metric: `${(project.builds || []).length} exports`,
        prompt: `Prepare ${project.title} for launch: store notes, beta cohort plan, QA checklist, analytics events, wallet policy notes, IAP review, and live operations plan.`
      }
    ];
  }

  function statusBadge(done) {
    return done ? `<span class="badge">Complete</span>` : `<span class="badge coral">Needs pass</span>`;
  }

  function showToast(message) {
    toast.textContent = message;
    toast.classList.add("show");
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => toast.classList.remove("show"), 3600);
  }

  async function api(path, options) {
    const config = {
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      ...options
    };
    if (config.body && typeof config.body !== "string") {
      config.body = JSON.stringify(config.body);
    }
    const response = await fetch(path, config);
    const contentType = response.headers.get("content-type") || "";
    const data = contentType.includes("application/json") ? await response.json() : await response.text();
    if (!response.ok) {
      throw new Error(data && data.error ? data.error : "Request failed.");
    }
    return data;
  }

  function formData(form) {
    return Object.fromEntries(new FormData(form).entries());
  }

  function currentProject() {
    return state.projects.find((project) => project.id === state.currentProjectId) || state.projects[0] || null;
  }

  function replaceProject(project) {
    const index = state.projects.findIndex((item) => item.id === project.id);
    if (index >= 0) {
      state.projects[index] = project;
    } else {
      state.projects.unshift(project);
    }
    state.currentProjectId = project.id;
  }

  async function loadSession() {
    try {
      const me = await api("/api/me");
      state.user = me.user;
      await loadProjects();
      state.screen = "portal";
    } catch {
      state.user = null;
      state.projects = [];
      state.screen = "home";
    }
    render();
  }

  async function loadProjects() {
    const data = await api("/api/projects");
    state.projects = data.projects || [];
    if (!state.currentProjectId && state.projects.length) {
      state.currentProjectId = state.projects[0].id;
    }
  }

  function render() {
    renderAccountActions();
    document.body.classList.toggle("home-surface", !state.user && (state.screen === "home" || state.screen === "auth"));
    document.body.classList.toggle("auth-surface", !state.user && state.screen === "auth");
    document.body.classList.toggle("portal-surface", Boolean(state.user));
    if (!state.user && state.screen === "auth") {
      app.innerHTML = renderAuthPage();
      activateMotion();
      return;
    }
    if (!state.user) {
      app.innerHTML = renderHome();
      activateMotion();
      return;
    }
    app.innerHTML = renderPortal();
    activateMotion();
  }

  function renderAccountActions() {
    if (state.user) {
      accountActions.innerHTML = `
        <span class="muted">Hi, ${escapeHtml(state.user.name.split(" ")[0])}</span>
        <button class="secondary-button" type="button" data-logout>Sign out</button>
      `;
      return;
    }
    accountActions.innerHTML = `
      <button class="ghost-button" type="button" data-screen="auth" data-auth-mode="login">Sign in</button>
      <button class="primary-button" type="button" data-screen="auth" data-auth-mode="register">Create account</button>
    `;
  }

  function renderHome() {
    const modes = [
      ["world", "World"],
      ["story", "Story"],
      ["character", "Cast"],
      ["economy", "Wallet"],
      ["build", "Export"]
    ];
    const feed = engineModeFeed(state.engineMode);
    return `
      <section class="parallax-hero" id="experience" data-parallax-scene>
        <video class="scene-video hero-autoplay-video" autoplay muted loop playsinline preload="auto">
          <source src="/assets/videos/user/space-game-hero.mp4" type="video/mp4">
        </video>
        <div class="scene-shade"></div>
        <div class="depth-layer depth-stars" aria-hidden="true"></div>
        <div class="depth-layer depth-rings" aria-hidden="true"></div>
        <div class="depth-layer depth-floor" aria-hidden="true"></div>

        <div class="cycle-hero-mark">
          <span>Comic30</span>
          <i></i>
        </div>
        <div class="cycle-hero-copy">
          <span>AI Game Creation Engine</span>
          <h1>Build a playable universe from your story.</h1>
          <p>Comic30 turns creator prompts into story worlds, character systems, reward economies, wallet events, in-app purchases, and iOS / Android project kits.</p>
          <div class="cycle-actions">
            <button class="cycle-button cycle-button-primary" type="button" data-screen="auth" data-auth-mode="register">Launch creator portal</button>
            <button class="cycle-button cycle-button-secondary" type="button" data-scroll-target="engine">Enter the world</button>
          </div>
          <button class="scroll-cue" type="button" data-scroll-target="engine" aria-label="Scroll to engine scenes"></button>
        </div>

        <aside class="live-console hero-console" aria-label="Comic30 AI director preview">
          <div class="console-top">
            <span>AI Director</span>
            <strong data-live-status>Export ready</strong>
          </div>
          <b data-engine-mode-label>${engineModeLabel(state.engineMode)}</b>
          <p data-engine-mode-copy>${engineModeDescription(state.engineMode)}</p>
          <div class="console-feed" data-engine-mode-feed>
            ${feed.map((line) => `<span>${escapeHtml(line)}</span>`).join("")}
          </div>
          <div class="console-modes" aria-label="Engine mode controls">
            ${modes.map(([mode, label]) => `
              <button class="${state.engineMode === mode ? "active" : ""}" type="button" data-engine-mode="${mode}">${label}</button>
            `).join("")}
          </div>
        </aside>
      </section>

      <section class="parallax-scene scene-world" id="engine" data-parallax-scene>
        <video class="scene-video" muted loop playsinline preload="metadata">
          <source src="/assets/videos/user/space-game-world.mp4" type="video/mp4">
        </video>
        <video class="scene-video-secondary terrain-backdrop-video" muted loop playsinline preload="metadata">
          <source src="/assets/videos/user/space-game-battle.mp4" type="video/mp4">
        </video>
        <div class="scene-shade"></div>
        <div class="motion-overlay world-video-panel" aria-hidden="true">
          <video muted loop playsinline preload="metadata">
            <source src="/assets/videos/user/space-game-terrain.mp4" type="video/mp4">
          </video>
          <span>Realtime world pass</span>
          <div class="overlay-hud-lines"><i></i><i></i><i></i></div>
        </div>
        <div class="motion-overlay world-secondary-panel" aria-hidden="true">
          <video muted loop playsinline preload="metadata">
            <source src="/assets/videos/user/robot-run-candidate-a.mp4" type="video/mp4">
          </video>
          <span>Robot run sim</span>
          <div class="overlay-hud-lines"><i></i><i></i><i></i></div>
        </div>
        <div class="model-scene world-model-scene" aria-label="Generated game world with imported space station and aircraft assets">
          <model-viewer class="scene-model world-station-model" src="/assets/models/generated/space-station-scene.glb" alt="Generated space station environment" auto-rotate camera-controls disable-zoom interaction-prompt="none" exposure="1.22" shadow-intensity="0.85" camera-orbit="-28deg 68deg 11m" field-of-view="48deg" loading="lazy"></model-viewer>
          <model-viewer class="scene-model world-aircraft-model" src="/assets/models/generated/e45-aircraft-clean.glb" alt="E-45 aircraft game asset" autoplay animation-name="Armature|Action" auto-rotate camera-controls disable-zoom interaction-prompt="none" exposure="1.35" shadow-intensity="0.85" camera-orbit="36deg 72deg 58m" field-of-view="62deg" scale="0.08 0.08 0.08" loading="lazy"></model-viewer>
          <div class="scene-model-hud world-model-hud">
            <span>World asset import</span>
            <strong>Station scene + aircraft rig</strong>
            <i>Biome lighting compiled</i>
            <i>Flight path generated</i>
          </div>
        </div>
        <div class="engine-node-map" aria-hidden="true">
          <i></i><i></i><i></i><i></i><i></i>
        </div>
        <div class="chapter-copy chapter-copy-right">
          <span>A new frontier</span>
          <h2>Assemble worlds in real time.</h2>
          <p>Terrain, missions, enemy pressure, lighting, reward paths, and player goals generate as editable systems, not disposable concept copy.</p>
        </div>
        <div class="scene-caption">
          <strong>World Builder</strong>
          <span>Prompt-to-map generation, biome logic, quest objectives, spawn rules, cinematic beats, and session pacing.</span>
        </div>
      </section>

      <section class="parallax-scene scene-role" data-parallax-scene>
        <video class="scene-video" muted loop playsinline preload="metadata">
          <source src="/assets/videos/user/robot-section-background.mp4" type="video/mp4">
        </video>
        <div class="scene-shade scene-shade-warm"></div>
        <div class="model-scene role-model-scene" aria-label="Generated cast scene with animated mech walker and character rig">
          <div class="branch-graph scene-branch-graph">
            <i></i><i></i><i></i><i></i><i></i>
          </div>
          <model-viewer class="scene-model neck-mech-model" src="/assets/models/generated/neck-mech-walker.glb" alt="Animated neck mech walker boss rig" autoplay animation-name="Neck_Mech_Rig|Idel" auto-rotate camera-controls disable-zoom interaction-prompt="none" exposure="1.12" shadow-intensity="1" camera-orbit="24deg 70deg 94m" field-of-view="45deg" scale="0.18 0.18 0.18" loading="lazy"></model-viewer>
          <div class="scene-model-hud role-model-hud">
            <span>Branching logic live</span>
            <strong>Mech boss rig</strong>
            <i>Ability kit linked</i>
            <i>Threat state seeded</i>
          </div>
        </div>
        <div class="chapter-copy chapter-copy-left">
          <span>Your role</span>
          <h2>Direct playable characters.</h2>
          <p>Comic30 connects character motives, faction pressure, ability kits, dialogue memory, and branching outcomes to the playable loop.</p>
        </div>
        <div class="choice-stack" aria-label="Narrative systems preview">
          <span>Ally loyalty +12</span>
          <span>Faction alert escalated</span>
          <span>Quest ending unlocked</span>
          <span>Boss ability tuned</span>
        </div>
      </section>

      <section class="parallax-scene scene-economy" data-parallax-scene>
        <video class="scene-video" muted loop playsinline preload="metadata">
          <source src="/assets/videos/user/space-game-battle.mp4" type="video/mp4">
        </video>
        <div class="scene-shade"></div>
        <div class="model-scene economy-model-scene" aria-label="Generated transport shuttle reward economy game scene">
          <model-viewer class="scene-model shuttle-model-viewer" src="/assets/models/generated/transport-shuttle.glb" alt="Rigged futuristic transport shuttle" autoplay animation-name="Armature|Shuttel_Fly_Animation" auto-rotate camera-controls disable-zoom interaction-prompt="none" exposure="1.25" shadow-intensity="0.85" camera-orbit="-32deg 68deg 78m" field-of-view="46deg" scale="0.16 0.16 0.16" loading="lazy"></model-viewer>
          <div class="shuttle-path"><i></i><i></i><i></i></div>
          <div class="economy-store-hud">
            <b>Asset Forge</b>
            <i>Transport shuttle rig imported</i>
            <i>Reward cargo route mapped</i>
            <i>IAP skin slots generated</i>
          </div>
          <div class="token-stream"><i></i><i></i><i></i><i></i><i></i></div>
        </div>
        <div class="economy-device-hud" aria-hidden="true">
          <div>
            <span>Player Balance</span>
            <strong>1,840 C30</strong>
          </div>
          <div>
            <span>Purchase Queue</span>
            <strong>3 products mapped</strong>
          </div>
        </div>
        <div class="wallet-orbit" aria-hidden="true">
          <i></i><i></i><i></i><i></i>
        </div>
        <div class="chapter-copy chapter-copy-right">
          <span>The economy</span>
          <h2>Tune rewards and purchases.</h2>
          <p>Model token rewards, IAP products, grants, sinks, ledger events, fraud checks, and progression pressure directly inside the game blueprint.</p>
        </div>
        <div class="economy-ledger">
          <span>Quest reward +25 C30</span>
          <span>Starter pack $4.99 mapped</span>
          <span>Daily sink pressure balanced</span>
          <span>Ledger audit passed</span>
        </div>
      </section>

      <section class="logo-ticker-section" aria-label="Comic30 partner ecosystem">
        <div class="logo-ticker-track">
          ${[0, 1, 2, 3].map(() => `
            <div class="logo-ticker-set">
              <img src="/assets/partners/nvidia-inception-white.png" alt="NVIDIA Inception Program">
              <img src="/assets/partners/fuelarts-white.png" alt="Fuelarts">
              <img src="/assets/partners/tech-logo-white.png" alt="TC">
              <img src="/assets/partners/tezos-white.png" alt="Tezos">
            </div>
          `).join("")}
        </div>
      </section>

      <section class="parallax-scene scene-export" data-parallax-scene>
        <video class="scene-video" muted loop playsinline preload="metadata">
          <source src="/assets/videos/user/space-game-launch.mp4" type="video/mp4">
        </video>
        <div class="scene-shade scene-shade-deep"></div>
        <div class="model-scene export-model-scene" aria-label="Generated mobile deployment game asset scene">
          <model-viewer class="scene-model five-wheeler-model" src="/assets/models/generated/five-wheeler.glb" alt="Animated futuristic five-wheeler deployment asset" autoplay animation-name="Five Wheeler|Idel" auto-rotate camera-controls disable-zoom interaction-prompt="none" exposure="1.2" shadow-intensity="1" camera-orbit="32deg 70deg 116m" field-of-view="45deg" scale="0.14 0.14 0.14" loading="lazy"></model-viewer>
          <div class="scene-model-hud export-model-hud">
            <span>Audience deploy preview</span>
            <strong>Playable asset packaged</strong>
            <i>Build target linked</i>
            <i>Store kit generated</i>
          </div>
          <div class="launch-device-stack">
            <b class="platform-badge platform-ios" aria-label="iOS build target">
              <svg viewBox="0 0 40 48" aria-hidden="true"><path d="M30.6 25.4c-.1-6.1 5-9 5.2-9.1-2.9-4.2-7.3-4.8-8.8-4.9-3.7-.4-7.2 2.2-9 2.2-1.9 0-4.7-2.1-7.7-2-4 .1-7.8 2.4-9.9 6.1-4.2 7.4-1.1 18.2 3 24.2 2 3 4.5 6.3 7.7 6.2 3.1-.1 4.2-2 7.9-2s4.7 2 8 1.9c3.3 0 5.4-3 7.4-6 2.3-3.4 3.2-6.7 3.3-6.9-.1-.1-6.9-2.7-7.1-9.7zM24.5 7.5c1.7-2.1 2.8-5 2.5-7.5-2.4.1-5.3 1.6-7 3.6-1.5 1.8-2.9 4.8-2.5 7.3 2.6.2 5.3-1.3 7-3.4z"/></svg>
              <span>iOS</span>
            </b>
            <b class="platform-badge platform-android" aria-label="Android build target">
              <svg viewBox="0 0 48 48" aria-hidden="true"><path d="M13.7 17.6h20.6c1.3 0 2.4 1.1 2.4 2.4v12.2c0 1.3-1.1 2.4-2.4 2.4H13.7c-1.3 0-2.4-1.1-2.4-2.4V20c0-1.3 1.1-2.4 2.4-2.4zM8.4 20.2c1 0 1.8.8 1.8 1.8v8.8c0 1-.8 1.8-1.8 1.8s-1.8-.8-1.8-1.8V22c0-1 .8-1.8 1.8-1.8zm31.2 0c1 0 1.8.8 1.8 1.8v8.8c0 1-.8 1.8-1.8 1.8s-1.8-.8-1.8-1.8V22c0-1 .8-1.8 1.8-1.8zM15.4 12.2l-3.1-4.5 2-1.4 3.4 4.9c1.9-.7 4-1.1 6.3-1.1s4.4.4 6.3 1.1l3.4-4.9 2 1.4-3.1 4.5c3 1.8 4.9 4.5 4.9 7.6H10.5c0-3.1 1.9-5.8 4.9-7.6zM18.7 15.6c.8 0 1.4-.6 1.4-1.4s-.6-1.4-1.4-1.4-1.4.6-1.4 1.4.6 1.4 1.4 1.4zm10.6 0c.8 0 1.4-.6 1.4-1.4s-.6-1.4-1.4-1.4-1.4.6-1.4 1.4.6 1.4 1.4 1.4zM16 35.8h4v5.1c0 1.1-.9 2-2 2s-2-.9-2-2v-5.1zm12 0h4v5.1c0 1.1-.9 2-2 2s-2-.9-2-2v-5.1z"/></svg>
              <span>Android</span>
            </b>
            <strong>Beta live</strong>
          </div>
        </div>
        <div class="launch-audience-hud" aria-hidden="true">
          <span>Creator build uploaded</span>
          <span>Store assets generated</span>
          <span>Player cohort ready</span>
        </div>
        <div class="build-lane" aria-label="Mobile build pipeline">
          <span><b>01</b> Brief</span>
          <span><b>02</b> Generate</span>
          <span><b>03</b> Balance</span>
          <span><b>04</b> QA</span>
          <span><b>05</b> Export</span>
        </div>
        <div class="chapter-copy chapter-copy-left">
          <span>Launch kit</span>
          <h2>Ship the mobile build kit.</h2>
          <p>The portal saves the project, exports structured build tasks, prepares store notes, and keeps economy/backend contracts tied to the game design.</p>
        </div>
      </section>

      <section class="parallax-scene scene-start" id="studio" data-parallax-scene>
        <video class="scene-video" muted loop playsinline preload="metadata">
          <source src="/assets/videos/user/robot-branching-logic.mp4" type="video/mp4">
        </video>
        <div class="scene-shade scene-shade-start"></div>
        <div class="start-copy">
          <span>Open the portal</span>
          <h2>Generate the first build blueprint.</h2>
          <p>Create an account to save the project, expand systems, tune the economy, record wallet events, and prepare the mobile export kit.</p>
        </div>
        <form class="portal-start-form" data-form="start-project">
          <div class="field-grid">
            <label class="field">
              <span>Game title</span>
              <input name="title" required maxlength="80" placeholder="Neon Rift">
            </label>
            <label class="field">
              <span>Genre</span>
              <input name="genre" maxlength="80" placeholder="Cinematic action RPG">
            </label>
            <label class="field full">
              <span>Core premise</span>
              <textarea name="premise" required placeholder="A rebel creator discovers that every player choice reshapes the city, its factions, and its reward economy."></textarea>
            </label>
            <label class="field full">
              <span>Art style</span>
              <input name="artStyle" maxlength="120" placeholder="Stylized AAA mobile realism">
            </label>
          </div>
          <div class="form-actions">
            <button class="cycle-button cycle-button-primary" type="submit">Generate blueprint</button>
            <span class="muted">Account required to save.</span>
          </div>
        </form>
      </section>
    `;
  }

  function renderAuthPage() {
    const isRegister = state.authMode === "register";
    return `
      <section class="auth-wrap auth-cinematic" data-parallax-scene>
        <video class="scene-video auth-backdrop-video" autoplay muted loop playsinline preload="auto">
          <source src="/assets/videos/user/space-game-portal.mp4" type="video/mp4">
        </video>
        <video class="scene-video-secondary" muted loop playsinline preload="metadata">
          <source src="/assets/videos/user/space-game-launch.mp4" type="video/mp4">
        </video>
        <div class="scene-shade scene-shade-deep"></div>
        <div class="auth-copy">
          <span>Creator access</span>
          <h1>${isRegister ? "Enter the Comic30 build deck." : "Resume the build deck."}</h1>
          <p>${state.draft ? "Your first game blueprint is staged. Sign in or create an account to save the project and continue building." : "Create worlds, direct character systems, balance rewards, and prepare mobile exports from one cinematic creator workspace."}</p>
          <div class="auth-signal-row" aria-hidden="true">
            <i>World</i>
            <i>Story</i>
            <i>Cast</i>
            <i>Wallet</i>
            <i>Export</i>
          </div>
        </div>
        <div class="auth-panel auth-panel-cinematic">
          <div class="auth-toggle">
            <button class="${isRegister ? "primary-button" : "secondary-button"}" type="button" data-auth-mode="register">Create account</button>
            <button class="${!isRegister ? "primary-button" : "secondary-button"}" type="button" data-auth-mode="login">Sign in</button>
          </div>
          <div class="panel-heading">
            <div>
              <h2>${isRegister ? "Create your Comic30 account" : "Welcome back"}</h2>
              <p>${state.draft ? "Your game blueprint is ready to save after authentication." : "Access the creator workspace and project engine."}</p>
            </div>
            <span class="badge ${isRegister ? "" : "gold"}">${isRegister ? "Creator" : "Session"}</span>
          </div>
          <form data-form="auth">
            <div class="field-grid">
              ${isRegister ? `
                <label class="field full">
                  <span>Name</span>
                  <input name="name" required autocomplete="name">
                </label>
              ` : ""}
              <label class="field full">
                <span>Email</span>
                <input name="email" type="email" required autocomplete="email">
              </label>
              <label class="field full">
                <span>Password</span>
                <input name="password" type="password" required minlength="8" autocomplete="${isRegister ? "new-password" : "current-password"}">
              </label>
            </div>
            <div class="form-actions">
              <button class="primary-button" type="submit">${isRegister ? "Create account" : "Sign in"}</button>
              <button class="ghost-button" type="button" data-screen="home">Back to site</button>
            </div>
          </form>
        </div>
      </section>
    `;
  }

  function renderPortal() {
    const project = currentProject();
    return `
      <section class="portal-shell">
        <video class="portal-backdrop-video" autoplay muted loop playsinline preload="auto">
          <source src="/assets/videos/user/space-game-portal.mp4" type="video/mp4">
        </video>
        <div class="portal-backdrop-shade" aria-hidden="true"></div>
        <div class="portal-marquee">
          <span>Comic30 creator operations</span>
          <strong>${project ? escapeHtml(project.title) : "Command deck"}</strong>
          <div>
            <b>Story AI</b>
            <b>Wallet Core</b>
            <b>Mobile Export</b>
          </div>
        </div>
        <div class="portal">
          ${renderSidebar(project)}
          <div class="workspace">
            ${project ? renderWorkspace(project) : (state.view === "new" ? renderNewProject() : renderEmptyWorkspace())}
          </div>
        </div>
      </section>
    `;
  }

  function renderSidebar(project) {
    const tabs = [
      ["overview", "Overview"],
      ["pipeline", "Pipeline"],
      ["agent", "AI Agent"],
      ["tools", "Tools"],
      ["studio", "Studio"],
      ["economy", "Economy"],
      ["builds", "Builds"],
      ["deploy", "Deploy"],
      ["manage", "Manage"]
    ];
    return `
      <aside class="sidebar">
        <div class="profile-card">
          <span class="operator-label">Creator operator</span>
          <strong>${escapeHtml(state.user.name)}</strong>
          <span>${escapeHtml(state.user.email)}</span>
        </div>
        <div class="project-switcher">
          <div class="panel-heading">
            <div>
              <h3>Projects</h3>
              <p>${state.projects.length} active</p>
            </div>
            <button class="icon-button" type="button" data-view="new" title="New project">+</button>
          </div>
          <div class="project-list">
            ${state.projects.map((item) => `
              <button class="project-choice ${project && project.id === item.id ? "active" : ""}" type="button" data-project-id="${escapeHtml(item.id)}">
                <strong>${escapeHtml(item.title)}</strong>
                <span>${escapeHtml(item.genre)} / ${escapeHtml(item.status)}</span>
              </button>
            `).join("") || `<span class="muted">No projects yet.</span>`}
          </div>
        </div>
        <div class="project-switcher">
          <div class="tab-list">
            ${tabs.map(([view, label]) => `
              <button class="tab-button ${state.view === view ? "active" : ""}" type="button" data-view="${view}">
                <span>${label}</span><span aria-hidden="true">></span>
              </button>
            `).join("")}
          </div>
        </div>
      </aside>
    `;
  }

  function renderWorkspace(project) {
    if (state.view === "new") {
      return renderNewProject();
    }
    return `
      <div class="workspace-ribbon">
        <div><span>Story Ops</span><strong>${project.story.length} arcs</strong></div>
        <div><span>Cast Ops</span><strong>${project.characters.length} units</strong></div>
        <div><span>World Ops</span><strong>${(project.terrain || []).length} terrain zones</strong></div>
        <div><span>Readiness</span><strong>${projectReadiness(project)}%</strong></div>
      </div>
      <div class="workspace-header">
        <div>
          <span class="eyebrow">${escapeHtml(project.status)} project</span>
          <h1>${escapeHtml(project.title)}</h1>
          <p class="muted">${escapeHtml(project.tagline)}</p>
        </div>
        <div class="toolbar">
          <button class="secondary-button" type="button" data-view="studio">Edit</button>
          <button class="primary-button" type="button" data-export-project="${escapeHtml(project.id)}">Export kit</button>
        </div>
      </div>
      ${state.view === "studio" ? renderStudio(project) : ""}
      ${state.view === "pipeline" ? renderPipeline(project) : ""}
      ${state.view === "agent" ? renderAgent(project) : ""}
      ${state.view === "tools" ? renderTools(project) : ""}
      ${state.view === "economy" ? renderEconomy(project) : ""}
      ${state.view === "builds" ? renderBuilds(project) : ""}
      ${state.view === "deploy" ? renderDeploy(project) : ""}
      ${state.view === "manage" ? renderManage(project) : ""}
      ${state.view === "overview" ? renderOverview(project) : ""}
    `;
  }

  function renderEmptyWorkspace() {
    return `
      <div class="empty-state">
        <div>
          <h2>Create the first Comic30 project</h2>
          <p>Turn a premise into a saved game blueprint with story arcs, characters, wallet economy, and mobile export data.</p>
          <button class="primary-button" type="button" data-view="new">New project</button>
        </div>
      </div>
    `;
  }

  function renderNewProject() {
    return `
      <div class="workspace-header">
        <div>
          <span class="eyebrow">New game world</span>
          <h1>Blueprint creator</h1>
          <p class="muted">Create the first pass of a mobile game project.</p>
        </div>
      </div>
      <form class="tool-panel" data-form="create-project">
        <div class="field-grid">
          <label class="field">
            <span>Game title</span>
            <input name="title" required maxlength="80" placeholder="Neon Rift">
          </label>
          <label class="field">
            <span>Genre</span>
            <input name="genre" maxlength="80" placeholder="Action RPG">
          </label>
          <label class="field">
            <span>Audience</span>
            <input name="audience" maxlength="120" placeholder="mobile-first RPG players">
          </label>
          <label class="field">
            <span>Art style</span>
            <input name="artStyle" maxlength="120" placeholder="Stylized AAA mobile realism">
          </label>
          <label class="field full">
            <span>Premise</span>
            <textarea name="premise" required placeholder="A creator-led world where player choices rewrite alliances and rewards."></textarea>
          </label>
        </div>
        <div class="form-actions">
          <button class="primary-button" type="submit">Create project</button>
        </div>
      </form>
    `;
  }

  function renderOverview(project) {
    const steps = pipelineSteps(project);
    return `
      <div class="stats-grid">
        <div class="stat"><strong>${project.story.length}</strong><span>Story arcs</span></div>
        <div class="stat"><strong>${project.characters.length}</strong><span>Characters</span></div>
        <div class="stat"><strong>${project.economy.iapProducts.length}</strong><span>IAP products</span></div>
        <div class="stat"><strong>${projectReadiness(project)}%</strong><span>Launch readiness</span></div>
      </div>
      <div class="creator-progress">
        ${steps.map((step, index) => `
          <button class="${step.done ? "done" : ""}" type="button" data-view="${escapeHtml(step.view)}">
            <b>${String(index + 1).padStart(2, "0")}</b>
            <span>${escapeHtml(step.title)}</span>
          </button>
        `).join("")}
      </div>
      <div class="workspace-grid">
        <div class="workspace-card">
          <div class="panel-heading">
            <div>
              <h3>Game direction</h3>
              <p>${escapeHtml(project.genre)} for ${escapeHtml(project.audience)}</p>
            </div>
            <span class="badge">${escapeHtml(project.design.engineTrack)}</span>
          </div>
          <p>${escapeHtml(project.design.premise)}</p>
          <ul class="list">
            <li class="list-item"><strong>Gameplay loop</strong><p>${escapeHtml(project.design.gameplayLoop)}</p></li>
            <li class="list-item"><strong>Art style</strong><p>${escapeHtml(project.design.artStyle)}</p></li>
          </ul>
        </div>
        <div class="workspace-card">
          ${renderPlayablePreview(project)}
        </div>
        <div class="workspace-card">
          <h3>Current story arcs</h3>
          <ul class="list">
            ${project.story.slice(0, 3).map((arc) => `
              <li class="list-item"><strong>${escapeHtml(arc.title)}</strong><p>${escapeHtml(arc.summary)}</p></li>
            `).join("")}
          </ul>
        </div>
        <div class="workspace-card">
          <h3>Launch readiness</h3>
          <ul class="list">
            ${steps.slice(0, 5).map((step) => `<li class="list-item"><strong>${escapeHtml(step.title)}</strong><p>${step.done ? "Ready for the next pass." : "Run the AI step or open the tool panel to complete this stage."}</p></li>`).join("")}
          </ul>
        </div>
      </div>
    `;
  }

  function renderPipeline(project) {
    const steps = pipelineSteps(project);
    return `
      <div class="pipeline-board">
        ${steps.map((step, index) => `
          <article class="pipeline-step ${step.done ? "complete" : ""}">
            <div class="pipeline-step-top">
              <b>${String(index + 1).padStart(2, "0")}</b>
              ${statusBadge(step.done)}
            </div>
            <h3>${escapeHtml(step.title)}</h3>
            <p>${escapeHtml(step.prompt)}</p>
            <span>${escapeHtml(step.metric)}</span>
            <div class="form-actions">
              <button class="secondary-button" type="button" data-view="${escapeHtml(step.view)}">Open</button>
              <button class="primary-button" type="button" data-agent-step="${escapeHtml(step.id)}">Run AI step</button>
            </div>
          </article>
        `).join("")}
      </div>
      <div class="workspace-grid">
        <div class="workspace-card">
          <h3>Creator runbook</h3>
          <ul class="list">
            <li class="list-item"><strong>1. Generate</strong><p>Use the AI step buttons to create story arcs, playable characters, world terrain, rewards, IAP products, and build jobs.</p></li>
            <li class="list-item"><strong>2. Edit</strong><p>Open Studio, Economy, and Tools to tune the saved project blueprint before packaging.</p></li>
            <li class="list-item"><strong>3. Package</strong><p>Generate native scaffold ZIPs and export the full game kit for Android Studio/Xcode handoff.</p></li>
            <li class="list-item"><strong>4. Deploy</strong><p>Use Deploy for store checklists, beta cohorts, QA gates, wallet review, and live operations.</p></li>
          </ul>
        </div>
        <div class="workspace-card">
          <h3>Current blockers</h3>
          <ul class="list">
            ${steps.filter((step) => !step.done).slice(0, 5).map((step) => `
              <li class="list-item"><strong>${escapeHtml(step.title)}</strong><p>${escapeHtml(step.metric)}. Run the AI step or open the editor.</p></li>
            `).join("") || `<li class="list-item"><strong>Pipeline complete</strong><p>Generate an export and move to launch review.</p></li>`}
          </ul>
        </div>
      </div>
    `;
  }

  function renderPlayablePreview(project) {
    const arc = project.story[state.previewArc % project.story.length];
    return `
      <div class="preview-stage">
        <div>
          <span class="badge coral">Playable preview</span>
          <h3>${escapeHtml(arc.title)}</h3>
        </div>
        <p>${escapeHtml(arc.summary)}</p>
        <div>
          <div class="choice-row">
            ${arc.choices.map((choice, index) => `
              <button class="choice-button" type="button" data-preview-choice="${index}">${escapeHtml(choice.label)}</button>
            `).join("")}
          </div>
          ${state.previewResult ? `<p class="muted">${escapeHtml(state.previewResult)}</p>` : ""}
        </div>
      </div>
    `;
  }

  function renderAgent(project) {
    const thread = (project.aiThreads && project.aiThreads[0]) || { messages: [] };
    const messages = thread.messages || [];
    const terrain = project.terrain || [];
    const jobs = project.buildJobs || [];
    return `
      <div class="agent-layout">
        <section class="tool-panel agent-command">
          <div class="panel-heading">
            <div>
              <h3>AI game creation agent</h3>
              <p>Create story, characters, worlds, economy systems, terrain, and mobile build jobs through chat.</p>
            </div>
            <span class="badge gold">Live engine</span>
          </div>
          <div class="chat-log" aria-label="AI agent chat history">
            ${messages.slice(-10).map((message) => `
              <article class="chat-message ${escapeHtml(message.role)}">
                <span>${escapeHtml(message.role === "user" ? "You" : message.agent || "Comic30")}</span>
                <p>${escapeHtml(message.content)}</p>
              </article>
            `).join("")}
          </div>
          <form class="agent-chat-form" data-form="agent-chat">
            <label class="field">
              <span>Command</span>
              <textarea name="message" required placeholder="Create a military companion, a playable storm-city terrain zone, a quest branch, wallet rewards, and generate the Android/iOS build scaffold."></textarea>
            </label>
            <div class="agent-command-row">
              <label class="field">
                <span>Module</span>
                <select name="module">
                  <option value="auto">Auto detect</option>
                  <option value="all">Full pass</option>
                  <option value="story">Story</option>
                  <option value="character">Character</option>
                  <option value="world">World/Terrain</option>
                  <option value="economy">Economy/IAP</option>
                  <option value="build">Mobile build</option>
                </select>
              </label>
              <button class="primary-button" type="submit">Run agent</button>
            </div>
          </form>
        </section>

        <aside class="tool-panel agent-status">
          <div class="panel-heading">
            <div>
              <h3>Engine state</h3>
              <p>Generated systems saved to the current project.</p>
            </div>
            <span class="badge">${escapeHtml(project.engine?.version || "runtime")}</span>
          </div>
          <div class="agent-metrics">
            <div><strong>${project.story.length}</strong><span>Story arcs</span></div>
            <div><strong>${project.characters.length}</strong><span>Characters</span></div>
            <div><strong>${project.worlds.length}</strong><span>Worlds</span></div>
            <div><strong>${terrain.length}</strong><span>Terrain zones</span></div>
          </div>
          <h3>Latest terrain</h3>
          <ul class="list">
            ${terrain.slice(-3).reverse().map((zone) => `
              <li class="list-item">
                <strong>${escapeHtml(zone.name)}</strong>
                <p>${escapeHtml(zone.biome)} / ${escapeHtml(zone.lighting || "cinematic lighting")}</p>
              </li>
            `).join("") || `<li class="list-item"><strong>No terrain yet</strong><p>Ask the agent to create a world or terrain zone.</p></li>`}
          </ul>
          <hr class="soft-rule">
          <h3>Build jobs</h3>
          <ul class="list">
            ${jobs.slice(0, 3).map((job) => `
              <li class="list-item">
                <strong>${escapeHtml(job.target)} / ${escapeHtml(job.status)}</strong>
                <p>${escapeHtml(job.notes)}</p>
                <div class="form-actions">
                  <a class="secondary-button" href="${escapeHtml(job.url)}">Download scaffold</a>
                </div>
              </li>
            `).join("") || `<li class="list-item"><strong>No build jobs yet</strong><p>Run the build module or generate a scaffold from Builds.</p></li>`}
          </ul>
          <div class="form-actions">
            <button class="secondary-button" type="button" data-build-project="${escapeHtml(project.id)}">Generate Android/iOS scaffold</button>
          </div>
        </aside>
      </div>
    `;
  }

  function renderStudio(project) {
    return `
      <div class="split">
        <form class="tool-panel" data-form="design-update">
          <div class="panel-heading">
            <div>
              <h3>Story and game design</h3>
              <p>Saved into the project blueprint and export bundle.</p>
            </div>
            <span class="badge">Design</span>
          </div>
          <div class="field-grid">
            <label class="field">
              <span>Title</span>
              <input name="title" required value="${escapeHtml(project.title)}">
            </label>
            <label class="field">
              <span>Status</span>
              <select name="status">
                ${["design", "prototype", "production", "launch-ready"].map((status) => `<option value="${status}" ${project.status === status ? "selected" : ""}>${status}</option>`).join("")}
              </select>
            </label>
            <label class="field">
              <span>Genre</span>
              <input name="genre" value="${escapeHtml(project.genre)}">
            </label>
            <label class="field">
              <span>Audience</span>
              <input name="audience" value="${escapeHtml(project.audience)}">
            </label>
            <label class="field full">
              <span>Tagline</span>
              <input name="tagline" value="${escapeHtml(project.tagline)}">
            </label>
            <label class="field full">
              <span>Premise</span>
              <textarea name="premise">${escapeHtml(project.design.premise)}</textarea>
            </label>
            <label class="field full">
              <span>Gameplay loop</span>
              <textarea name="gameplayLoop">${escapeHtml(project.design.gameplayLoop)}</textarea>
            </label>
            <label class="field full">
              <span>Art style</span>
              <input name="artStyle" value="${escapeHtml(project.design.artStyle)}">
            </label>
          </div>
          <div class="form-actions">
            <button class="primary-button" type="submit">Save design</button>
          </div>
        </form>

        <div class="tool-panel">
          <div class="panel-heading">
            <div>
              <h3>AI design pass</h3>
              <p>Add a generated story arc and character to the current project.</p>
            </div>
            <span class="badge gold">Copilot</span>
          </div>
          <form data-form="generate-pass">
            <label class="field">
              <span>Direction</span>
              <textarea name="prompt" placeholder="Add a rivalry arc around player-created factions and a wallet reward dilemma."></textarea>
            </label>
            <div class="form-actions">
              <button class="secondary-button" type="submit">Generate pass</button>
            </div>
          </form>
          <hr class="soft-rule">
          <h3>Character roster</h3>
          <ul class="list">
            ${project.characters.map((character) => `
              <li class="list-item">
                <strong>${escapeHtml(character.name)}</strong>
                <p>${escapeHtml(character.role)}: ${escapeHtml(character.motive)}</p>
              </li>
            `).join("")}
          </ul>
          <form data-form="character-add">
            <div class="field-grid">
              <label class="field">
                <span>Name</span>
                <input name="name" required placeholder="Ari Flux">
              </label>
              <label class="field">
                <span>Role</span>
                <input name="role" required placeholder="player rival">
              </label>
              <label class="field full">
                <span>Motive</span>
                <textarea name="motive" required placeholder="Win control of the faction economy without losing the player base."></textarea>
              </label>
            </div>
            <div class="form-actions">
              <button class="secondary-button" type="submit">Add character</button>
            </div>
          </form>
        </div>
      </div>
    `;
  }

  function renderTools(project) {
    const tools = [
      {
        title: "Narrative Director",
        module: "story",
        detail: "Quest arcs, dialogue memory, faction pressure, choice consequences, endings.",
        prompt: `Create a deeper branching narrative pass for ${project.title} with quests, choices, dialogue memory, faction pressure, and cinematic beats.`
      },
      {
        title: "Character Rig Lab",
        module: "character",
        detail: "Heroes, companions, rivals, bosses, ability kits, rig manifests.",
        prompt: `Create playable characters, enemies, ability kits, motives, boss behavior, and animation rig notes for ${project.title}.`
      },
      {
        title: "Terrain Builder",
        module: "world",
        detail: "Worlds, terrain zones, biomes, POIs, enemy spawns, lighting, missions.",
        prompt: `Build a new AAA mobile terrain zone for ${project.title} with points of interest, spawn rules, mission objectives, lighting, and reward paths.`
      },
      {
        title: "Wallet Economy",
        module: "economy",
        detail: "Internal ledger, C30 rewards, sinks, IAP SKUs, fraud checks, store guardrails.",
        prompt: `Tune ${project.title}'s wallet economy with balanced rewards, sinks, IAP products, ledger events, anti-fraud checks, and app-store review notes.`
      },
      {
        title: "Mobile Packager",
        module: "build",
        detail: "Android/iOS scaffold ZIP, engine payload, store notes, QA checklist.",
        prompt: `Package ${project.title} into Android and iOS scaffold builds with runtime payload, store notes, QA gates, and launch checklist.`
      },
      {
        title: "Live Ops Planner",
        module: "all",
        detail: "Retention loops, beta cohorts, season plan, analytics events, content updates.",
        prompt: `Create a live operations plan for ${project.title}: beta cohorts, launch events, analytics events, retention loops, reward cadence, and update roadmap.`
      }
    ];
    return `
      <div class="tool-launch-grid">
        ${tools.map((tool) => `
          <article class="workspace-card tool-launch-card">
            <span class="badge gold">${escapeHtml(tool.module)}</span>
            <h3>${escapeHtml(tool.title)}</h3>
            <p>${escapeHtml(tool.detail)}</p>
            <div class="form-actions">
              <button class="primary-button" type="button" data-agent-command="${escapeHtml(tool.module)}" data-agent-prompt="${escapeHtml(tool.prompt)}">Run tool</button>
            </div>
          </article>
        `).join("")}
      </div>
      <div class="workspace-card">
        <h3>Generated game systems</h3>
        <div class="system-matrix">
          <div><strong>${project.story.length}</strong><span>Story arcs</span></div>
          <div><strong>${project.characters.length}</strong><span>Characters</span></div>
          <div><strong>${project.worlds.length}</strong><span>Worlds</span></div>
          <div><strong>${(project.terrain || []).length}</strong><span>Terrain zones</span></div>
          <div><strong>${project.economy.rewards?.length || 0}</strong><span>Rewards</span></div>
          <div><strong>${project.economy.iapProducts?.length || 0}</strong><span>IAP SKUs</span></div>
        </div>
      </div>
      <div class="workspace-card">
        <div class="panel-heading">
          <div>
            <h3>3D model demo imports</h3>
            <p>Personal-use test models that demonstrate the kinds of space assets Comic30 can ingest, place into scenes, and package into game projects.</p>
          </div>
          <span class="badge">Asset examples</span>
        </div>
        <div class="model-example-grid">
          <a href="https://free3d.com/3d-model/space-station-scene-520279.html" target="_blank" rel="noreferrer">
            <strong>Space station scene</strong>
            <span>World hub / orbital base / mission staging</span>
          </a>
          <a href="https://free3d.com/3d-model/e-45-aircraft-71823.html" target="_blank" rel="noreferrer">
            <strong>E-45 aircraft</strong>
            <span>Playable vehicle / enemy craft / cinematic fly-by</span>
          </a>
          <a href="https://free3d.com/3d-model/futuristic-transport-shuttle-rigged--18765.html" target="_blank" rel="noreferrer">
            <strong>Futuristic transport shuttle</strong>
            <span>Rigged shuttle / cargo reward loop / launch scene</span>
          </a>
        </div>
      </div>
    `;
  }

  function renderEconomy(project) {
    const ledger = project.ledger || [];
    return `
      <div class="split">
        <div class="tool-panel">
          <div class="panel-heading">
            <div>
              <h3>Wallet economy</h3>
              <p>${escapeHtml(project.economy.chainReadiness)}</p>
            </div>
            <span class="badge">${escapeHtml(project.economy.walletMode)}</span>
          </div>
          <form data-form="economy-update">
            <div class="field-grid">
              <label class="field">
                <span>Currency name</span>
                <input name="currencyName" value="${escapeHtml(project.economy.currencyName)}">
              </label>
              <label class="field">
                <span>Symbol</span>
                <input name="currencySymbol" value="${escapeHtml(project.economy.currencySymbol)}" maxlength="12">
              </label>
              <label class="field">
                <span>Starting balance</span>
                <input name="startingBalance" type="number" value="${escapeHtml(project.economy.startingBalance)}">
              </label>
              <label class="field">
                <span>Max supply</span>
                <input name="maxSupply" type="number" value="${escapeHtml(project.economy.maxSupply)}">
              </label>
            </div>
            <div class="form-actions">
              <button class="primary-button" type="submit">Save economy</button>
            </div>
          </form>
          <h3>In-app products</h3>
          <ul class="list">
            ${project.economy.iapProducts.map((product) => `
              <li class="list-item">
                <strong>${escapeHtml(product.name)} / $${money(product.priceUsd)}</strong>
                <p>${escapeHtml(product.platformSku)} grants ${money(product.grants)} ${escapeHtml(project.economy.currencySymbol)}</p>
              </li>
            `).join("")}
          </ul>
          <form data-form="iap-add">
            <div class="field-grid">
              <label class="field">
                <span>Name</span>
                <input name="name" required placeholder="Founder's Pack">
              </label>
              <label class="field">
                <span>Platform SKU</span>
                <input name="platformSku" required placeholder="comic30.founders.pack">
              </label>
              <label class="field">
                <span>Price USD</span>
                <input name="priceUsd" type="number" step="0.01" required placeholder="19.99">
              </label>
              <label class="field">
                <span>Grants</span>
                <input name="grants" type="number" required placeholder="2500">
              </label>
            </div>
            <div class="form-actions">
              <button class="secondary-button" type="submit">Add product</button>
            </div>
          </form>
        </div>

        <div class="tool-panel">
          <div class="panel-heading">
            <div>
              <h3>Internal ledger</h3>
              <p>Issue demo credits and debits against player IDs.</p>
            </div>
            <span class="badge gold">${ledger.length} tx</span>
          </div>
          <form data-form="ledger-add">
            <div class="field-grid">
              <label class="field">
                <span>Player ID</span>
                <input name="playerId" required value="demo-player">
              </label>
              <label class="field">
                <span>Amount</span>
                <input name="amount" type="number" required value="25">
              </label>
              <label class="field full">
                <span>Reason</span>
                <input name="reason" required value="Quest completion reward">
              </label>
            </div>
            <div class="form-actions">
              <button class="secondary-button" type="submit">Record transaction</button>
            </div>
          </form>
          <h3>Ledger events</h3>
          <ul class="list">
            ${ledger.slice(0, 8).map((tx) => `
              <li class="list-item">
                <strong>${tx.amount > 0 ? "+" : ""}${money(tx.amount)} ${escapeHtml(project.economy.currencySymbol)} / ${escapeHtml(tx.playerId)}</strong>
                <p>${escapeHtml(tx.reason)} / ${escapeHtml(tx.hash.slice(0, 18))}</p>
              </li>
            `).join("") || `<li class="list-item"><strong>No transactions yet</strong><p>Ledger activity appears after a reward or debit is recorded.</p></li>`}
          </ul>
        </div>
      </div>
    `;
  }

  function renderBuilds(project) {
    const jobs = project.buildJobs || [];
    return `
      <div class="split">
        <div class="tool-panel">
          <div class="panel-heading">
            <div>
              <h3>Android/iOS build scaffold</h3>
              <p>Generates native starter projects with story, characters, terrain, economy, and runtime data bundled.</p>
            </div>
            <span class="badge coral">iOS + Android</span>
          </div>
          <ul class="list">
            <li class="list-item"><strong>Native scaffold</strong><p>Android Java starter and iOS Swift starter that load the Comic30 project payload.</p></li>
            <li class="list-item"><strong>Engine payload</strong><p>Story, characters, worlds, terrain, wallet economy, IAP products, and agent history.</p></li>
            <li class="list-item"><strong>Launch requirements</strong><p>Signed app builds still require Android Studio or macOS/Xcode plus store credentials.</p></li>
          </ul>
          <div class="form-actions">
            <button class="primary-button" type="button" data-build-project="${escapeHtml(project.id)}">Generate Android/iOS scaffold</button>
            <button class="secondary-button" type="button" data-export-project="${escapeHtml(project.id)}">Generate full export</button>
          </div>
        </div>
        <div class="tool-panel">
          <h3>Recent build jobs</h3>
          <ul class="list">
            ${jobs.map((job) => `
              <li class="list-item">
                <strong>${escapeHtml(job.target)} / ${escapeHtml(job.status)} / ${(job.size / 1024).toFixed(1)} KB</strong>
                <p>${escapeHtml(job.compileStatus?.android || "")}</p>
                <p>${escapeHtml(job.compileStatus?.ios || "")}</p>
                <div class="form-actions">
                  <a class="secondary-button" href="${escapeHtml(job.url)}">Download scaffold</a>
                </div>
              </li>
            `).join("") || `<li class="list-item"><strong>No build jobs yet</strong><p>Generate the Android/iOS scaffold when the project is ready.</p></li>`}
          </ul>
          <hr class="soft-rule">
          <h3>Recent exports</h3>
          <ul class="list">
            ${project.builds.map((build) => `
              <li class="list-item">
                <strong>${escapeHtml(build.type)} / ${(build.size / 1024).toFixed(1)} KB</strong>
                <p>${escapeHtml(new Date(build.createdAt).toLocaleString())}</p>
                <div class="form-actions">
                  <a class="secondary-button" href="${escapeHtml(build.url)}">Download</a>
                </div>
              </li>
            `).join("") || `<li class="list-item"><strong>No exports yet</strong><p>Generate a project kit when the blueprint is ready.</p></li>`}
          </ul>
        </div>
      </div>
    `;
  }

  function renderDeploy(project) {
    const readiness = projectReadiness(project);
    const tasks = [
      ["Store metadata", "Generate app name, short description, screenshots, gameplay trailer, support URL, privacy policy link, and keywords."],
      ["Build signing", "Configure Android release keystore and Apple provisioning profiles before producing signed AAB/APK/IPA files."],
      ["IAP review", "Confirm all IAP SKUs, prices, grants, restore behavior, purchase receipts, and non-pay-to-win design rules."],
      ["Wallet policy", "Decide custody model, chain integration, disclosures, tax/legal review, fraud monitoring, and regional restrictions."],
      ["QA gates", "Run first-launch, tutorial, combat loop, reward grant, purchase restore, account deletion, crash, and performance smoke tests."],
      ["Live ops", "Prepare beta cohorts, analytics events, content calendar, reward cadence, support workflow, and incident response."]
    ];
    return `
      <div class="deploy-grid">
        <section class="tool-panel deploy-hero">
          <div class="panel-heading">
            <div>
              <h3>Launch command</h3>
              <p>Prepare ${escapeHtml(project.title)} for beta, store review, and live operations.</p>
            </div>
            <span class="badge coral">${readiness}% ready</span>
          </div>
          <div class="readiness-meter" style="--ready:${readiness}%"><span></span></div>
          <ul class="list">
            ${tasks.map(([title, copy]) => `<li class="list-item"><strong>${escapeHtml(title)}</strong><p>${escapeHtml(copy)}</p></li>`).join("")}
          </ul>
          <div class="form-actions">
            <button class="primary-button" type="button" data-build-project="${escapeHtml(project.id)}">Generate scaffold</button>
            <button class="secondary-button" type="button" data-export-project="${escapeHtml(project.id)}">Export launch kit</button>
          </div>
        </section>
        <aside class="tool-panel">
          <h3>Deployment artifacts</h3>
          <ul class="list">
            ${(project.builds || []).slice(0, 5).map((build) => `
              <li class="list-item">
                <strong>${escapeHtml(build.type)}</strong>
                <p>${escapeHtml(new Date(build.createdAt).toLocaleString())} / ${(build.size / 1024).toFixed(1)} KB</p>
                <div class="form-actions"><a class="secondary-button" href="${escapeHtml(build.url)}">Download</a></div>
              </li>
            `).join("") || `<li class="list-item"><strong>No deployment artifacts yet</strong><p>Generate a scaffold or full export first.</p></li>`}
          </ul>
          <hr class="soft-rule">
          <h3>Store targets</h3>
          <div class="system-matrix compact">
            <div><strong>Android</strong><span>AAB/APK scaffold</span></div>
            <div><strong>iOS</strong><span>Xcode scaffold</span></div>
            <div><strong>Backend</strong><span>Project JSON API</span></div>
            <div><strong>Wallet</strong><span>${escapeHtml(project.economy.walletMode)}</span></div>
          </div>
        </aside>
      </div>
    `;
  }

  function renderManage(project) {
    const ledger = project.ledger || [];
    return `
      <div class="split">
        <form class="tool-panel" data-form="project-settings">
          <div class="panel-heading">
            <div>
              <h3>Project management</h3>
              <p>Control project status, positioning, and production notes.</p>
            </div>
            <span class="badge">${escapeHtml(project.status)}</span>
          </div>
          <div class="field-grid">
            <label class="field">
              <span>Status</span>
              <select name="status">
                ${["design", "prototype", "production", "beta", "launch-ready", "live"].map((status) => `<option value="${status}" ${project.status === status ? "selected" : ""}>${status}</option>`).join("")}
              </select>
            </label>
            <label class="field">
              <span>Audience</span>
              <input name="audience" value="${escapeHtml(project.audience)}">
            </label>
            <label class="field full">
              <span>Tagline</span>
              <input name="tagline" value="${escapeHtml(project.tagline)}">
            </label>
            <label class="field full">
              <span>Gameplay loop</span>
              <textarea name="gameplayLoop">${escapeHtml(project.design.gameplayLoop)}</textarea>
            </label>
          </div>
          <div class="form-actions">
            <button class="primary-button" type="submit">Save management settings</button>
          </div>
        </form>
        <div class="tool-panel">
          <h3>Operations dashboard</h3>
          <div class="system-matrix">
            <div><strong>${projectReadiness(project)}%</strong><span>Readiness</span></div>
            <div><strong>${ledger.length}</strong><span>Ledger tx</span></div>
            <div><strong>${project.buildJobs.length}</strong><span>Build jobs</span></div>
            <div><strong>${project.aiThreads?.[0]?.messages?.length || 0}</strong><span>Agent messages</span></div>
          </div>
          <hr class="soft-rule">
          <h3>Next actions</h3>
          <ul class="list">
            ${pipelineSteps(project).filter((step) => !step.done).slice(0, 4).map((step) => `
              <li class="list-item"><strong>${escapeHtml(step.title)}</strong><p>${escapeHtml(step.prompt)}</p></li>
            `).join("") || `<li class="list-item"><strong>Ready for launch review</strong><p>Export the launch kit and validate signed app builds with native toolchains.</p></li>`}
          </ul>
        </div>
      </div>
    `;
  }

  async function createProjectFromDraft(draft) {
    const data = await api("/api/projects", { method: "POST", body: draft });
    replaceProject(data.project);
    state.view = "studio";
    showToast("Project blueprint created.");
  }

  async function withSubmitLock(form, callback) {
    const buttons = Array.from(form.querySelectorAll("button"));
    buttons.forEach((button) => { button.disabled = true; });
    try {
      await callback();
    } catch (error) {
      showToast(error.message);
    } finally {
      buttons.forEach((button) => { button.disabled = false; });
    }
  }

  document.addEventListener("click", async (event) => {
    const engineModeButton = event.target.closest("[data-engine-mode]");
    if (engineModeButton) {
      setEngineMode(engineModeButton.dataset.engineMode || "world", { animate: true, announce: true });
      startEngineModeCycle();
      return;
    }

    const screenButton = event.target.closest("[data-screen]");
    if (screenButton) {
      state.screen = screenButton.dataset.screen;
      if (screenButton.dataset.authMode) {
        state.authMode = screenButton.dataset.authMode;
      }
      render();
      return;
    }

    const authButton = event.target.closest("[data-auth-mode]");
    if (authButton) {
      state.screen = "auth";
      state.authMode = authButton.dataset.authMode;
      render();
      return;
    }

    const scrollButton = event.target.closest("[data-scroll-target]");
    if (scrollButton) {
      document.getElementById(scrollButton.dataset.scrollTarget)?.scrollIntoView({ behavior: "smooth" });
      return;
    }

    const logoutButton = event.target.closest("[data-logout]");
    if (logoutButton) {
      try {
        await api("/api/auth/logout", { method: "POST", body: {} });
      } catch {
        // The local session can still be cleared client-side.
      }
      state.user = null;
      state.projects = [];
      state.currentProjectId = null;
      state.screen = "home";
      render();
      showToast("Signed out.");
      return;
    }

    const viewButton = event.target.closest("[data-view]");
    if (viewButton) {
      state.view = viewButton.dataset.view;
      state.previewResult = "";
      render();
      return;
    }

    const projectButton = event.target.closest("[data-project-id]");
    if (projectButton) {
      state.currentProjectId = projectButton.dataset.projectId;
      state.view = "overview";
      state.previewResult = "";
      render();
      return;
    }

    const previewButton = event.target.closest("[data-preview-choice]");
    if (previewButton) {
      const project = currentProject();
      const arc = project.story[state.previewArc % project.story.length];
      const choice = arc.choices[Number(previewButton.dataset.previewChoice)];
      state.previewResult = `${choice.consequence} Reward: +${project.economy.startingBalance} ${project.economy.currencySymbol}.`;
      state.previewArc = (state.previewArc + 1) % project.story.length;
      render();
      return;
    }

    const buildButton = event.target.closest("[data-build-project]");
    if (buildButton) {
      buildButton.disabled = true;
      try {
        const data = await api(`/api/projects/${buildButton.dataset.buildProject}/build`, {
          method: "POST",
          body: { target: "all" }
        });
        replaceProject(data.project);
        state.view = "builds";
        showToast("Android/iOS scaffold generated.");
        render();
      } catch (error) {
        showToast(error.message);
      } finally {
        buildButton.disabled = false;
      }
      return;
    }

    const agentStepButton = event.target.closest("[data-agent-step]");
    if (agentStepButton) {
      const project = currentProject();
      const step = project ? pipelineSteps(project).find((item) => item.id === agentStepButton.dataset.agentStep) : null;
      if (!project || !step) return;
      agentStepButton.disabled = true;
      try {
        const response = await api(`/api/projects/${project.id}/agent`, {
          method: "POST",
          body: { message: step.prompt, module: step.module }
        });
        replaceProject(response.project);
        state.view = step.view === "deploy" ? "deploy" : "pipeline";
        render();
        showToast(`${step.title} AI pass saved.`);
      } catch (error) {
        showToast(error.message);
      } finally {
        agentStepButton.disabled = false;
      }
      return;
    }

    const agentCommandButton = event.target.closest("[data-agent-command]");
    if (agentCommandButton) {
      const project = currentProject();
      if (!project) return;
      agentCommandButton.disabled = true;
      try {
        const response = await api(`/api/projects/${project.id}/agent`, {
          method: "POST",
          body: {
            message: agentCommandButton.dataset.agentPrompt,
            module: agentCommandButton.dataset.agentCommand
          }
        });
        replaceProject(response.project);
        state.view = "tools";
        render();
        showToast("Tool pass saved.");
      } catch (error) {
        showToast(error.message);
      } finally {
        agentCommandButton.disabled = false;
      }
      return;
    }

    const exportButton = event.target.closest("[data-export-project]");
    if (exportButton) {
      exportButton.disabled = true;
      try {
        const data = await api(`/api/projects/${exportButton.dataset.exportProject}/export`, { method: "POST", body: {} });
        const project = currentProject();
        project.builds.unshift(data.build);
        showToast("Export generated.");
        state.view = "builds";
        render();
      } catch (error) {
        showToast(error.message);
      } finally {
        exportButton.disabled = false;
      }
    }
  });

  document.addEventListener("submit", async (event) => {
    const form = event.target.closest("form[data-form]");
    if (!form) return;
    event.preventDefault();

    await withSubmitLock(form, async () => {
      const data = formData(form);
      const kind = form.dataset.form;
      const project = currentProject();

      if (kind === "start-project") {
        state.draft = data;
        if (!state.user) {
          state.screen = "auth";
          state.authMode = "register";
          render();
          return;
        }
        await createProjectFromDraft(data);
        render();
        return;
      }

      if (kind === "auth") {
        const path = state.authMode === "register" ? "/api/auth/register" : "/api/auth/login";
        const response = await api(path, { method: "POST", body: data });
        state.user = response.user;
        await loadProjects();
        if (state.draft) {
          await createProjectFromDraft(state.draft);
          state.draft = null;
        }
        state.screen = "portal";
        render();
        showToast(state.authMode === "register" ? "Account created." : "Signed in.");
        return;
      }

      if (kind === "create-project") {
        await createProjectFromDraft(data);
        render();
        return;
      }

      if (!project) return;

      if (kind === "agent-chat") {
        const response = await api(`/api/projects/${project.id}/agent`, {
          method: "POST",
          body: {
            message: data.message,
            module: data.module
          }
        });
        replaceProject(response.project);
        state.view = "agent";
        render();
        showToast("Agent pass saved.");
        return;
      }

      if (kind === "design-update") {
        const response = await api(`/api/projects/${project.id}`, {
          method: "PUT",
          body: {
            title: data.title,
            status: data.status,
            genre: data.genre,
            audience: data.audience,
            tagline: data.tagline,
            design: {
              premise: data.premise,
              gameplayLoop: data.gameplayLoop,
              artStyle: data.artStyle
            }
          }
        });
        replaceProject(response.project);
        render();
        showToast("Design saved.");
        return;
      }

      if (kind === "project-settings") {
        const response = await api(`/api/projects/${project.id}`, {
          method: "PUT",
          body: {
            status: data.status,
            audience: data.audience,
            tagline: data.tagline,
            design: {
              gameplayLoop: data.gameplayLoop
            }
          }
        });
        replaceProject(response.project);
        render();
        showToast("Project management settings saved.");
        return;
      }

      if (kind === "generate-pass") {
        const response = await api(`/api/projects/${project.id}/generate`, {
          method: "POST",
          body: { prompt: data.prompt }
        });
        replaceProject(response.project);
        render();
        showToast("Design pass generated.");
        return;
      }

      if (kind === "character-add") {
        const character = {
          id: `char_${Date.now()}`,
          name: data.name,
          role: data.role,
          motive: data.motive,
          abilities: ["creator-defined ability"]
        };
        const response = await api(`/api/projects/${project.id}`, {
          method: "PUT",
          body: { characters: [...project.characters, character] }
        });
        replaceProject(response.project);
        render();
        showToast("Character added.");
        return;
      }

      if (kind === "economy-update") {
        const response = await api(`/api/projects/${project.id}`, {
          method: "PUT",
          body: {
            economy: {
              currencyName: data.currencyName,
              currencySymbol: data.currencySymbol,
              startingBalance: Number(data.startingBalance),
              maxSupply: Number(data.maxSupply)
            }
          }
        });
        replaceProject(response.project);
        render();
        showToast("Economy saved.");
        return;
      }

      if (kind === "iap-add") {
        const product = {
          id: `iap_${Date.now()}`,
          name: data.name,
          platformSku: data.platformSku,
          priceUsd: Number(data.priceUsd),
          grants: Number(data.grants)
        };
        const response = await api(`/api/projects/${project.id}`, {
          method: "PUT",
          body: { economy: { iapProducts: [...project.economy.iapProducts, product] } }
        });
        replaceProject(response.project);
        render();
        showToast("IAP product added.");
        return;
      }

      if (kind === "ledger-add") {
        const response = await api(`/api/projects/${project.id}/ledger`, {
          method: "POST",
          body: {
            playerId: data.playerId,
            amount: Number(data.amount),
            reason: data.reason
          }
        });
        project.ledger = response.ledger.transactions;
        render();
        showToast("Ledger transaction recorded.");
      }
    });
  });

  loadSession();
  initNeuralCanvas();

  function activateMotion() {
    requestAnimationFrame(() => {
      setupRevealMotion();
      startLiveStatus();
      startEngineModeCycle();
      setupEngineViewport();
      setupManagedVideos();
      setupManagedModels();
      setupParallaxScenes();
    });
  }

  function setupRevealMotion() {
    const targets = Array.from(document.querySelectorAll(
      ".engine-shot, .ue-engine-panel, .ue-updates article, .ue-section-head, .ue-media-card, .ue-workflow-grid article, .ue-launch-copy, .ue-launch-form, .engine-dock, .theater-stats div, .theater-timeline, .motion-panel, .launch-panel, .sponsor-strip span, .engine-card, .economy-copy, .economy-orbit, .ledger-board, .portal-preview, .workspace, .project-switcher, .workspace-card, .tool-panel"
    ));
    targets.forEach((element) => element.classList.add("reveal"));

    if (motion.observer) {
      motion.observer.disconnect();
    }

    if (!("IntersectionObserver" in window)) {
      targets.forEach((element) => element.classList.add("is-visible"));
      return;
    }

    motion.observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          motion.observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.14 });

    targets.forEach((element) => motion.observer.observe(element));
  }

  function setupParallaxScenes() {
    if (motion.parallaxHandler) {
      window.removeEventListener("scroll", motion.parallaxHandler);
      window.removeEventListener("resize", motion.parallaxHandler);
      motion.parallaxHandler = null;
    }
    if (motion.parallaxFrame) {
      cancelAnimationFrame(motion.parallaxFrame);
      motion.parallaxFrame = null;
    }

    const scenes = Array.from(document.querySelectorAll("[data-parallax-scene]"));

    if (!scenes.length || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      scenes.forEach((scene) => scene.style.setProperty("--scene-shift", "0"));
      return;
    }

    const update = () => {
      const viewportHeight = window.innerHeight || 1;
      scenes.forEach((scene) => {
        const rect = scene.getBoundingClientRect();
        const centerOffset = (rect.top + rect.height / 2 - viewportHeight / 2) / viewportHeight;
        const clamped = Math.max(-1, Math.min(1, centerOffset));
        const distance = Math.abs(clamped);
        const focus = Math.max(0, 1 - distance * 0.75);
        scene.style.setProperty("--scene-shift", clamped.toFixed(4));
        scene.style.setProperty("--scene-y", `${Math.round(clamped * -56)}px`);
        scene.style.setProperty("--scene-y-soft", `${Math.round(clamped * -26)}px`);
        scene.style.setProperty("--scene-y-deep", `${Math.round(clamped * 84)}px`);
        scene.style.setProperty("--scene-focus", focus.toFixed(4));
        scene.style.setProperty("--scene-opacity", (0.46 + focus * 0.54).toFixed(4));
        scene.style.setProperty("--scene-scale", (1 + distance * 0.018).toFixed(4));
        scene.style.setProperty("--scene-video-scale", (1.07 + distance * 0.055).toFixed(4));
        scene.style.setProperty("--scene-card-scale", (0.965 + focus * 0.035).toFixed(4));
        scene.style.setProperty("--scene-fade", (0.28 + focus * 0.72).toFixed(4));
        scene.style.setProperty("--scene-edge-fade", (distance * 0.7).toFixed(4));
        scene.style.setProperty("--scene-content-opacity", (0.38 + focus * 0.62).toFixed(4));
        scene.classList.toggle("is-scene-active", distance < 0.42);
        scene.classList.toggle("is-scene-near", distance < 0.82);
      });
    };

    const schedule = () => {
      if (motion.parallaxFrame) {
        return;
      }
      motion.parallaxFrame = requestAnimationFrame(() => {
        motion.parallaxFrame = null;
        update();
      });
    };

    motion.parallaxHandler = schedule;
    update();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule, { passive: true });
  }

  function setupManagedVideos() {
    const videos = Array.from(document.querySelectorAll("video"));
    if (motion.videoObserver) {
      motion.videoObserver.disconnect();
      motion.videoObserver = null;
    }
    if (motion.videoWarmObserver) {
      motion.videoWarmObserver.disconnect();
      motion.videoWarmObserver = null;
    }
    if (motion.videoResizeHandler) {
      window.removeEventListener("resize", motion.videoResizeHandler);
      motion.videoResizeHandler = null;
    }
    if (motion.videoFrame) {
      cancelAnimationFrame(motion.videoFrame);
      motion.videoFrame = null;
    }
    if (!videos.length) {
      return;
    }

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const visibleVideos = new Map();
    const heroVideo = document.querySelector(".parallax-hero .scene-video");
    const playVideo = (video) => {
      if (reduceMotion) {
        return;
      }
      video.muted = true;
      video.playsInline = true;
      video.preload = "auto";
      if (video.readyState < 2) {
        video.load();
      }
      video.play?.().catch(() => {});
    };
    const pauseVideo = (video) => {
      video.pause?.();
    };

    videos.forEach((video, index) => {
      video.dataset.videoIndex = String(index);
      video.dataset.videoPriority = video === heroVideo
        ? "5"
        : video.closest(".motion-overlay")
          ? "4"
          : video.classList.contains("scene-video")
            ? "2"
            : "1";
      video.preload = video === heroVideo ? "auto" : "metadata";
      video.muted = true;
      video.playsInline = true;
      if (video !== heroVideo) {
        pauseVideo(video);
      }
    });

    if (heroVideo) {
      heroVideo.autoplay = true;
      heroVideo.setAttribute("autoplay", "");
      visibleVideos.set(heroVideo, 1);
      playVideo(heroVideo);
      window.setTimeout(() => playVideo(heroVideo), 250);
      window.setTimeout(() => playVideo(heroVideo), 900);
    }

    if (!("IntersectionObserver" in window)) {
      videos.slice(0, 2).forEach(playVideo);
      return;
    }

    const updateActiveVideos = () => {
      const entries = Array.from(visibleVideos.entries()).filter(([, ratio]) => ratio >= 0.14);
      let active = [];

      if (heroVideo && (visibleVideos.get(heroVideo) || 0) >= 0.12) {
        active = [heroVideo];
      } else {
        const sectionScores = new Map();
        entries.forEach(([video, ratio]) => {
          if (video === heroVideo) return;
          const section = video.closest("[data-parallax-scene]");
          if (!section) return;
          const score = (sectionScores.get(section) || 0) + ratio;
          sectionScores.set(section, score);
        });
        const activeSection = Array.from(sectionScores.entries())
          .sort(([, scoreA], [, scoreB]) => scoreB - scoreA)[0]?.[0];
        if (activeSection) {
          const maxSectionVideos = activeSection.classList.contains("scene-world") && !window.matchMedia("(max-width: 900px)").matches ? 2 : 1;
          active = entries
            .filter(([video]) => video !== heroVideo && video.closest("[data-parallax-scene]") === activeSection)
            .sort(([videoA, ratioA], [videoB, ratioB]) => {
              const scoreA = ratioA + Number(videoA.dataset.videoPriority || 1) * 0.16;
              const scoreB = ratioB + Number(videoB.dataset.videoPriority || 1) * 0.16;
              return scoreB - scoreA;
            })
            .slice(0, maxSectionVideos)
            .map(([video]) => video);
        }
      }

      videos.forEach((video) => {
        if (active.includes(video)) {
          playVideo(video);
        } else {
          pauseVideo(video);
        }
      });
    };

    motion.videoWarmObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        const video = entry.target;
        if (entry.isIntersecting) {
          video.preload = "auto";
          if (video.readyState < 2) {
            video.load();
          }
        }
      });
    }, { rootMargin: "700px 0px", threshold: 0.01 });

    motion.videoObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        const video = entry.target;
        if (entry.isIntersecting && entry.intersectionRatio >= 0.18) {
          visibleVideos.set(video, entry.intersectionRatio);
        } else {
          visibleVideos.delete(video);
        }
      });
      if (!motion.videoFrame) {
        motion.videoFrame = requestAnimationFrame(() => {
          motion.videoFrame = null;
          updateActiveVideos();
        });
      }
    }, { rootMargin: "120px 0px", threshold: [0, 0.18, 0.4] });

    videos.forEach((video) => {
      motion.videoWarmObserver.observe(video);
      motion.videoObserver.observe(video);
    });
    motion.videoResizeHandler = updateActiveVideos;
    window.addEventListener("resize", motion.videoResizeHandler, { passive: true });
  }

  function setupManagedModels() {
    const models = Array.from(document.querySelectorAll("model-viewer"));
    if (motion.modelObserver) {
      motion.modelObserver.disconnect();
      motion.modelObserver = null;
    }
    if (!models.length || window.matchMedia("(prefers-reduced-motion: reduce)").matches || !("IntersectionObserver" in window)) {
      return;
    }

    const activateModel = (model) => {
      model.autoRotate = model.dataset.autoRotate !== "false";
      const playback = model.play?.();
      playback?.catch?.(() => {});
    };
    const suspendModel = (model) => {
      model.autoRotate = false;
      model.pause?.();
    };

    models.forEach((model) => {
      model.dataset.autoRotate = model.hasAttribute("auto-rotate") ? "true" : "false";
      suspendModel(model);
    });

    motion.modelObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting && entry.intersectionRatio >= 0.16) {
          activateModel(entry.target);
        } else {
          suspendModel(entry.target);
        }
      });
    }, { rootMargin: "260px 0px", threshold: [0, 0.16, 0.38] });

    models.forEach((model) => motion.modelObserver.observe(model));
  }

  function startLiveStatus() {
    window.clearInterval(motion.statusTimer);
    document.querySelectorAll("[data-live-status]").forEach((node) => {
      node.textContent = engineModeStatus(state.engineMode);
    });
  }

  function startEngineModeCycle() {
    window.clearInterval(motion.engineCycleTimer);
    const hasConsole = document.querySelector("[data-engine-mode]");
    if (!hasConsole || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setEngineMode(state.engineMode, { animate: false });
      return;
    }

    let index = engineModeSequence.indexOf(state.engineMode);
    if (index < 0) {
      index = 0;
    }
    setEngineMode(engineModeSequence[index], { animate: false });
    motion.engineCycleTimer = window.setInterval(() => {
      index = (index + 1) % engineModeSequence.length;
      setEngineMode(engineModeSequence[index], { animate: true });
    }, 3600);
  }

  function setupCinematicReel() {
    const canvas = document.getElementById("cinematic-reel");
    if (!canvas || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (motion.cinematicCanvas === canvas) return;

    if (motion.cinematicFrame) {
      cancelAnimationFrame(motion.cinematicFrame);
    }

    motion.cinematicCanvas = canvas;
    const context = canvas.getContext("2d");
    if (!context) return;

    let width = 0;
    let height = 0;
    let pointer = { x: 0.62, y: 0.46 };
    const sparks = Array.from({ length: 130 }, () => ({
      x: Math.random(),
      y: Math.random(),
      z: Math.random(),
      speed: 0.00035 + Math.random() * 0.0015,
      drift: Math.random() * Math.PI * 2
    }));
    const drones = Array.from({ length: 8 }, (_, index) => ({
      x: 0.48 + index * 0.055 + Math.random() * 0.08,
      y: 0.2 + Math.random() * 0.22,
      phase: Math.random() * Math.PI * 2,
      size: 12 + Math.random() * 14
    }));

    canvas.addEventListener("pointermove", (event) => {
      const rect = canvas.getBoundingClientRect();
      pointer = {
        x: (event.clientX - rect.left) / rect.width,
        y: (event.clientY - rect.top) / rect.height
      };
    }, { passive: true });

    function resize() {
      const rect = canvas.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      width = Math.max(1, rect.width);
      height = Math.max(1, rect.height);
      canvas.width = Math.floor(width * ratio);
      canvas.height = Math.floor(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
    }

    function polygon(points, fill, stroke) {
      context.beginPath();
      points.forEach(([x, y], index) => {
        if (index === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      });
      context.closePath();
      if (fill) {
        context.fillStyle = fill;
        context.fill();
      }
      if (stroke) {
        context.strokeStyle = stroke;
        context.stroke();
      }
    }

    function palette(mode) {
      return {
        world: ["#d9e2ea", "#8b929b", "#d3a45f"],
        story: ["#d9d4ff", "#8f9bb0", "#cda66d"],
        character: ["#d8e7d8", "#9aa5a8", "#d3a45f"],
        economy: ["#e5c77b", "#d8e7d8", "#9aa5a8"],
        build: ["#e8edf2", "#9aa5a8", "#d3a45f"]
      }[mode] || ["#d9e2ea", "#8b929b", "#d3a45f"];
    }

    function drawPanel(x, y, w, h, title, accent, time, rows = 5) {
      context.save();
      context.fillStyle = "rgba(1, 5, 10, 0.66)";
      context.strokeStyle = accent;
      context.lineWidth = 1;
      context.fillRect(x, y, w, h);
      context.strokeRect(x, y, w, h);
      context.fillStyle = accent;
      context.font = "700 11px Arial";
      context.fillText(title, x + 14, y + 22);
      for (let i = 0; i < rows; i += 1) {
        const rowY = y + 42 + i * 18;
        const progress = 0.38 + Math.abs(Math.sin(time * 0.0017 + i)) * 0.52;
        context.fillStyle = "rgba(255,255,255,0.08)";
        context.fillRect(x + 14, rowY, w - 28, 6);
        context.fillStyle = i % 2 ? "rgba(205,166,109,0.42)" : accent;
        context.fillRect(x + 14, rowY, (w - 28) * progress, 6);
      }
      context.restore();
    }

    function drawBackdrop(time, colors) {
      const sky = context.createLinearGradient(0, 0, width, height);
      sky.addColorStop(0, "#02050a");
      sky.addColorStop(0.34, "#090615");
      sky.addColorStop(0.67, "#061720");
      sky.addColorStop(1, "#020306");
      context.fillStyle = sky;
      context.fillRect(0, 0, width, height);

      const lightX = width * (0.58 + (pointer.x - 0.5) * 0.09);
      const lightY = height * (0.26 + (pointer.y - 0.5) * 0.05);
      const glow = context.createRadialGradient(lightX, lightY, 12, lightX, lightY, width * 0.5);
      glow.addColorStop(0, `${colors[0]}55`);
      glow.addColorStop(0.4, `${colors[1]}22`);
      glow.addColorStop(1, "rgba(0,0,0,0)");
      context.fillStyle = glow;
      context.fillRect(0, 0, width, height);

      sparks.forEach((spark) => {
        spark.y += spark.speed;
        spark.x += Math.sin(time * 0.00055 + spark.drift) * 0.00032;
        if (spark.y > 1.08) {
          spark.y = -0.08;
          spark.x = Math.random();
        }
        const size = 0.8 + spark.z * 3.4;
        context.fillStyle = spark.z > 0.58 ? `${colors[0]}cc` : `${colors[1]}99`;
        context.fillRect(spark.x * width, spark.y * height, size, size);
      });
    }

    function drawTerrain(time, colors) {
      const horizon = height * 0.6;
      const parallaxX = (pointer.x - 0.5) * 48;
      const parallaxY = (pointer.y - 0.5) * 22;
      context.save();

      for (let layer = 0; layer < 3; layer += 1) {
        const offset = ((time * (0.012 + layer * 0.011)) % width) - width;
        context.fillStyle = layer === 0 ? "rgba(15, 17, 35, 0.8)" : layer === 1 ? "rgba(7, 18, 28, 0.92)" : "rgba(3, 10, 16, 0.98)";
        context.beginPath();
        context.moveTo(0, horizon + layer * 40);
        for (let repeat = 0; repeat < 3; repeat += 1) {
          const base = offset + repeat * width + parallaxX * (layer + 1) * 0.22;
          for (let i = 0; i <= 10; i += 1) {
            const x = base + (i / 10) * width;
            const y = height * (0.33 + layer * 0.08) + Math.sin(i * 1.4 + time * 0.00045 + layer) * 38;
            context.lineTo(x, y);
          }
        }
        context.lineTo(width, height);
        context.lineTo(0, height);
        context.closePath();
        context.fill();
      }

      context.strokeStyle = `${colors[0]}33`;
      context.lineWidth = 1;
      for (let i = 0; i < 22; i += 1) {
        const x = width * (i / 21);
        context.beginPath();
        context.moveTo(width * 0.58 + parallaxX, horizon + parallaxY);
        context.lineTo(x, height);
        context.stroke();
      }
      for (let i = 0; i < 10; i += 1) {
        const y = horizon + i * 38 + ((time * 0.025) % 38) + parallaxY;
        context.beginPath();
        context.moveTo(width * 0.18, y);
        context.lineTo(width, y + i * 8);
        context.stroke();
      }

      for (let i = 0; i < 11; i += 1) {
        const x = width * (0.45 + i * 0.042) + Math.sin(time * 0.0009 + i) * 12 + parallaxX * 0.4;
        const h = height * (0.12 + (i % 4) * 0.035);
        const y = horizon - h + Math.sin(i + time * 0.001) * 8;
        const w = width * (0.018 + (i % 3) * 0.006);
        const fill = i % 3 === 0 ? `${colors[1]}36` : `${colors[0]}2f`;
        polygon([[x, y], [x + w, y + 12], [x + w, horizon + 12], [x, horizon]], fill, `${colors[0]}66`);
      }

      context.restore();
    }

    function drawCharacterAndDrones(time, colors) {
      context.save();
      const heroX = width * (0.7 + (pointer.x - 0.5) * 0.025);
      const baseY = height * (0.8 + (pointer.y - 0.5) * 0.012);
      const bodyH = Math.min(150, height * 0.2);
      context.fillStyle = "rgba(0, 0, 0, 0.78)";
      polygon([[heroX - 32, baseY], [heroX - 16, baseY - bodyH], [heroX + 16, baseY - bodyH], [heroX + 34, baseY]], "rgba(0,0,0,0.8)", `${colors[0]}55`);
      context.fillStyle = `${colors[1]}cc`;
      context.fillRect(heroX - 18, baseY - bodyH - 18, 36, 14);
      context.strokeStyle = `${colors[2]}cc`;
      context.lineWidth = 3;
      context.beginPath();
      context.moveTo(heroX + 18, baseY - bodyH + 34);
      context.lineTo(heroX + 98, baseY - bodyH - 42 + Math.sin(time * 0.004) * 6);
      context.stroke();

      drones.forEach((drone, index) => {
        const x = drone.x * width + Math.sin(time * 0.0014 + drone.phase) * 42;
        const y = drone.y * height + Math.cos(time * 0.0019 + drone.phase) * 18;
        context.strokeStyle = index % 2 ? `${colors[1]}aa` : `${colors[0]}aa`;
        context.fillStyle = "rgba(0,0,0,0.56)";
        context.beginPath();
        context.ellipse(x, y, drone.size * 1.8, drone.size * 0.72, 0, 0, Math.PI * 2);
        context.fill();
        context.stroke();
        context.fillStyle = index % 2 ? `${colors[1]}cc` : `${colors[0]}cc`;
        context.fillRect(x - 3, y - 2, 6, 4);
      });
      context.restore();
    }

    function drawStoryGraph(time, colors) {
      context.save();
      const nodes = [[0.48, 0.28], [0.6, 0.2], [0.72, 0.32], [0.58, 0.48], [0.77, 0.58], [0.66, 0.72], [0.5, 0.62]];
      context.lineWidth = 2;
      nodes.forEach((node, index) => {
        for (let j = index + 1; j < nodes.length; j += 1) {
          if (Math.abs(index - j) > 3) continue;
          context.strokeStyle = `${colors[(index + j) % 2]}66`;
          context.beginPath();
          context.moveTo(node[0] * width, node[1] * height);
          context.lineTo(nodes[j][0] * width, nodes[j][1] * height);
          context.stroke();
        }
      });
      nodes.forEach((node, index) => {
        const pulse = Math.sin(time * 0.004 + index);
        context.fillStyle = pulse > 0 ? `${colors[1]}dd` : `${colors[0]}cc`;
        context.fillRect(node[0] * width - 12, node[1] * height - 12, 24, 24);
      });
      context.restore();
    }

    function drawCharacterRig(time, colors) {
      context.save();
      const x = width * 0.62;
      const y = height * 0.48;
      const pulse = Math.sin(time * 0.003) * 8;
      context.strokeStyle = `${colors[0]}bb`;
      context.lineWidth = 3;
      context.beginPath();
      context.arc(x, y - 86, 22, 0, Math.PI * 2);
      context.moveTo(x, y - 64);
      context.lineTo(x, y + 40);
      context.moveTo(x, y - 30);
      context.lineTo(x - 72, y + pulse);
      context.moveTo(x, y - 30);
      context.lineTo(x + 72, y - pulse);
      context.moveTo(x, y + 40);
      context.lineTo(x - 54, y + 118);
      context.moveTo(x, y + 40);
      context.lineTo(x + 58, y + 114);
      context.stroke();
      for (let i = 0; i < 7; i += 1) {
        const px = [x, x, x - 72, x + 72, x - 54, x + 58, x][i];
        const py = [y - 86, y - 30, y + pulse, y - pulse, y + 118, y + 114, y + 40][i];
        context.fillStyle = i % 2 ? `${colors[1]}dd` : `${colors[0]}dd`;
        context.beginPath();
        context.arc(px, py, 7, 0, Math.PI * 2);
        context.fill();
      }
      context.restore();
    }

    function drawEconomyRings(time, colors) {
      context.save();
      const x = width * 0.65;
      const y = height * 0.48;
      for (let ring = 0; ring < 4; ring += 1) {
        context.strokeStyle = `${colors[ring % 3]}66`;
        context.lineWidth = ring === 1 ? 3 : 1;
        context.beginPath();
        context.arc(x, y, 54 + ring * 42 + Math.sin(time * 0.002 + ring) * 5, 0, Math.PI * 2);
        context.stroke();
      }
      for (let i = 0; i < 16; i += 1) {
        const a = time * 0.0012 + i * 0.55;
        const r = 78 + (i % 4) * 34;
        const px = x + Math.cos(a) * r;
        const py = y + Math.sin(a) * r * 0.68;
        context.fillStyle = i % 3 === 0 ? `${colors[2]}dd` : `${colors[0]}cc`;
        context.fillRect(px - 8, py - 8, 16, 16);
      }
      context.fillStyle = "rgba(0,0,0,0.62)";
      context.strokeStyle = `${colors[0]}aa`;
      context.fillRect(x - 74, y - 32, 148, 64);
      context.strokeRect(x - 74, y - 32, 148, 64);
      context.fillStyle = colors[0];
      context.font = "800 18px Arial";
      context.fillText("+25 C30", x - 42, y + 6);
      context.restore();
    }

    function drawBuildDevices(time, colors) {
      context.save();
      for (let i = 0; i < 2; i += 1) {
        const x = width * (0.58 + i * 0.14);
        const y = height * 0.48 + Math.sin(time * 0.002 + i) * 10;
        const w = 76;
        const h = 152;
        context.fillStyle = "rgba(0,0,0,0.72)";
        context.strokeStyle = `${colors[i]}bb`;
        context.lineWidth = 2;
        context.fillRect(x - w / 2, y - h / 2, w, h);
        context.strokeRect(x - w / 2, y - h / 2, w, h);
        const grad = context.createLinearGradient(x - w / 2, y - h / 2, x + w / 2, y + h / 2);
        grad.addColorStop(0, `${colors[0]}55`);
        grad.addColorStop(1, `${colors[2]}44`);
        context.fillStyle = grad;
        context.fillRect(x - w / 2 + 8, y - h / 2 + 16, w - 16, h - 32);
      }
      context.strokeStyle = `${colors[0]}99`;
      context.setLineDash([8, 8]);
      context.beginPath();
      context.moveTo(width * 0.46, height * 0.3);
      context.bezierCurveTo(width * 0.54, height * 0.18, width * 0.72, height * 0.22, width * 0.84, height * 0.36);
      context.stroke();
      context.setLineDash([]);
      context.restore();
    }

    function drawEditorHud(time, mode, colors) {
      const right = Math.max(230, width * 0.19);
      drawPanel(width - right - 36, height * 0.14, right, 156, "INSPECTOR / " + mode.toUpperCase(), `${colors[0]}aa`, time, 5);
      drawPanel(width - right - 72, height * 0.44, right * 0.88, 128, "BUILD QUEUE", `${colors[1]}aa`, time + 500, 4);
      drawPanel(width * 0.46, height * 0.12, Math.max(220, width * 0.18), 108, "AI COMMAND STREAM", `${colors[2]}aa`, time + 900, 3);
    }

    function draw(time) {
      resize();
      context.clearRect(0, 0, width, height);
      const mode = canvas.dataset.engineViewMode || state.engineMode;
      const colors = palette(mode);

      drawBackdrop(time, colors);
      drawTerrain(time, colors);
      drawCharacterAndDrones(time, colors);

      if (mode === "story") drawStoryGraph(time, colors);
      if (mode === "character") drawCharacterRig(time, colors);
      if (mode === "economy") drawEconomyRings(time, colors);
      if (mode === "build") drawBuildDevices(time, colors);

      context.fillStyle = "rgba(255,255,255,0.06)";
      context.fillRect(0, height * 0.88 + Math.sin(time * 0.004) * 12, width, 2);

      motion.cinematicFrame = requestAnimationFrame(draw);
    }

    draw(0);
  }

  function setupProofCanvases() {
    const canvases = Array.from(document.querySelectorAll(".proof-canvas"));
    motion.proofFrames.forEach((frame) => cancelAnimationFrame(frame));
    motion.proofFrames = [];

    if (!canvases.length || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    canvases.forEach((canvas, index) => {
      const context = canvas.getContext("2d");
      if (!context) return;

      let pointer = { x: 0.5, y: 0.5 };
      canvas.addEventListener("pointermove", (event) => {
        const rect = canvas.getBoundingClientRect();
        pointer = {
          x: (event.clientX - rect.left) / rect.width,
          y: (event.clientY - rect.top) / rect.height
        };
      }, { passive: true });

      function resizeCanvas() {
        const rect = canvas.getBoundingClientRect();
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.max(1, Math.floor(rect.width * ratio));
        canvas.height = Math.max(1, Math.floor(rect.height * ratio));
        context.setTransform(ratio, 0, 0, ratio, 0, 0);
        return { width: rect.width, height: rect.height };
      }

      function proofBackdrop(width, height, time, accent) {
        const gradient = context.createLinearGradient(0, 0, width, height);
        gradient.addColorStop(0, "#05080f");
        gradient.addColorStop(0.48, "#07121b");
        gradient.addColorStop(1, "#020407");
        context.fillStyle = gradient;
        context.fillRect(0, 0, width, height);

        const glow = context.createRadialGradient(width * (0.55 + (pointer.x - 0.5) * 0.08), height * 0.35, 10, width * 0.55, height * 0.35, width * 0.58);
        glow.addColorStop(0, accent);
        glow.addColorStop(1, "rgba(0,0,0,0)");
        context.fillStyle = glow;
        context.fillRect(0, 0, width, height);

        context.strokeStyle = "rgba(255,255,255,0.06)";
        for (let x = -40; x < width + 40; x += 40) {
          context.beginPath();
          context.moveTo(x + (time * 0.018) % 40, 0);
          context.lineTo(x - width * 0.18, height);
          context.stroke();
        }
        for (let y = -40; y < height + 40; y += 40) {
          context.beginPath();
          context.moveTo(0, y + (time * 0.018) % 40);
          context.lineTo(width, y);
          context.stroke();
        }
      }

      function drawProofWorld(width, height, time) {
        const horizon = height * 0.58;
        const parallax = (pointer.x - 0.5) * 30;
        context.fillStyle = "rgba(10, 14, 32, 0.86)";
        context.beginPath();
        context.moveTo(0, horizon - height * 0.22);
        for (let i = 0; i <= 10; i += 1) {
          context.lineTo(width * (i / 10), horizon - height * (0.18 + (i % 3) * 0.06) + Math.sin(time * 0.001 + i) * 12);
        }
        context.lineTo(width, horizon);
        context.lineTo(0, horizon);
        context.closePath();
        context.fill();

        context.strokeStyle = "rgba(216,226,234,0.16)";
        for (let i = 0; i < 16; i += 1) {
          context.beginPath();
          context.moveTo(width * 0.58 + parallax, horizon);
          context.lineTo(width * (i / 15), height);
          context.stroke();
        }
        for (let i = 0; i < 8; i += 1) {
          context.beginPath();
          context.moveTo(0, horizon + i * 34 + (time * 0.025) % 34);
          context.lineTo(width, horizon + i * 44 + (time * 0.025) % 34);
          context.stroke();
        }

        for (let i = 0; i < 7; i += 1) {
          const x = width * (0.22 + i * 0.09) + parallax * 0.4;
          const y = horizon - height * (0.08 + (i % 3) * 0.04) + Math.sin(time * 0.001 + i) * 8;
          const w = width * (0.045 + (i % 2) * 0.018);
          const h = height * (0.13 + (i % 4) * 0.05);
          context.fillStyle = i % 2 ? "rgba(205,166,109,0.24)" : "rgba(216,226,234,0.2)";
          context.beginPath();
          context.moveTo(x, y);
          context.lineTo(x + w, y + h * 0.14);
          context.lineTo(x + w, horizon + 8);
          context.lineTo(x, horizon);
          context.closePath();
          context.fill();
          context.strokeStyle = i % 2 ? "rgba(205,166,109,0.52)" : "rgba(216,226,234,0.46)";
          context.stroke();
        }

        const heroX = width * 0.58 + parallax * 0.25;
        const baseY = height * 0.83;
        context.fillStyle = "rgba(0,0,0,0.78)";
        context.beginPath();
        context.moveTo(heroX - 24, baseY);
        context.lineTo(heroX - 10, baseY - height * 0.22);
        context.lineTo(heroX + 12, baseY - height * 0.22);
        context.lineTo(heroX + 28, baseY);
        context.closePath();
        context.fill();
        context.strokeStyle = "rgba(211,164,95,0.82)";
        context.lineWidth = 3;
        context.beginPath();
        context.moveTo(heroX + 14, baseY - height * 0.16);
        context.lineTo(heroX + width * 0.12, baseY - height * 0.31 + Math.sin(time * 0.004) * 8);
        context.stroke();

        for (let i = 0; i < 5; i += 1) {
          const x = width * (0.42 + i * 0.08) + Math.sin(time * 0.0016 + i) * 28;
          const y = height * (0.26 + (i % 2) * 0.09) + Math.cos(time * 0.0019 + i) * 14;
          context.fillStyle = "rgba(0,0,0,0.56)";
          context.strokeStyle = i % 2 ? "rgba(205,166,109,0.62)" : "rgba(216,226,234,0.58)";
          context.beginPath();
          context.ellipse(x, y, 24, 9, 0, 0, Math.PI * 2);
          context.fill();
          context.stroke();
        }
      }

      function drawProofEditor(width, height, time) {
        const panels = [
          [0.06, 0.12, 0.34, 0.68],
          [0.45, 0.1, 0.22, 0.3],
          [0.7, 0.18, 0.24, 0.58]
        ];
        panels.forEach(([x, y, w, h], panelIndex) => {
          context.fillStyle = "rgba(0,0,0,0.44)";
          context.strokeStyle = panelIndex === 1 ? "rgba(205,166,109,0.62)" : "rgba(216,226,234,0.46)";
          context.fillRect(x * width, y * height, w * width, h * height);
          context.strokeRect(x * width, y * height, w * width, h * height);
          for (let i = 0; i < 7; i += 1) {
            context.fillStyle = i % 2 ? "rgba(205,166,109,0.34)" : "rgba(216,226,234,0.3)";
            context.fillRect(x * width + 18, y * height + 24 + i * 22, (w * width - 36) * (0.35 + Math.abs(Math.sin(time * 0.002 + i)) * 0.55), 6);
          }
        });
        context.strokeStyle = "rgba(211,164,95,0.56)";
        context.beginPath();
        context.moveTo(width * 0.36, height * 0.38);
        context.bezierCurveTo(width * 0.5, height * 0.16, width * 0.58, height * 0.72, width * 0.82, height * 0.48);
        context.stroke();
      }

      function drawProofCharacter(width, height, time) {
        const positions = [0.28, 0.5, 0.72];
        positions.forEach((position, i) => {
          const x = width * position;
          const y = height * 0.66;
          const tall = height * (0.42 + i * 0.04);
          context.strokeStyle = i === 1 ? "rgba(216,231,216,0.72)" : "rgba(216,226,234,0.58)";
          context.lineWidth = 2;
          context.beginPath();
          context.arc(x, y - tall, 18, 0, Math.PI * 2);
          context.moveTo(x, y - tall + 18);
          context.lineTo(x, y - 46);
          context.moveTo(x, y - tall + 62);
          context.lineTo(x - 42, y - 12 + Math.sin(time * 0.004 + i) * 8);
          context.moveTo(x, y - tall + 62);
          context.lineTo(x + 42, y - 18 - Math.sin(time * 0.004 + i) * 8);
          context.moveTo(x, y - 46);
          context.lineTo(x - 36, y);
          context.moveTo(x, y - 46);
          context.lineTo(x + 36, y);
          context.stroke();
          context.fillStyle = i === 1 ? "rgba(216,231,216,0.32)" : "rgba(205,166,109,0.3)";
          context.fillRect(x - 34, y - tall + 44, 68, 92);
        });
      }

      function drawProofEconomy(width, height, time) {
        const cx = width * 0.5;
        const cy = height * 0.48;
        for (let r = 0; r < 4; r += 1) {
          context.strokeStyle = r % 2 ? "rgba(216,231,216,0.4)" : "rgba(211,164,95,0.5)";
          context.beginPath();
          context.arc(cx, cy, 52 + r * 42, 0, Math.PI * 2);
          context.stroke();
        }
        for (let i = 0; i < 22; i += 1) {
          const angle = time * 0.0012 + i * 0.43;
          const radius = 72 + (i % 4) * 38;
          const x = cx + Math.cos(angle) * radius;
          const y = cy + Math.sin(angle) * radius * 0.62;
          context.fillStyle = i % 3 ? "rgba(211,164,95,0.72)" : "rgba(216,231,216,0.64)";
          context.fillRect(x - 7, y - 7, 14, 14);
        }
        context.fillStyle = "rgba(0,0,0,0.58)";
        context.strokeStyle = "rgba(211,164,95,0.64)";
        context.fillRect(cx - 102, cy - 42, 204, 84);
        context.strokeRect(cx - 102, cy - 42, 204, 84);
        context.fillStyle = "#d3a45f";
        context.font = "800 22px Arial";
        context.fillText("LEDGER BALANCED", cx - 94, cy + 7);
      }

      function draw(time) {
        const { width, height } = resizeCanvas();
        const scene = canvas.dataset.proofScene || "world";
        const accent = scene === "economy" ? "rgba(211,164,95,0.2)" : scene === "character" ? "rgba(216,231,216,0.18)" : "rgba(216,226,234,0.18)";
        proofBackdrop(width, height, time + index * 300, accent);
        if (scene === "world") drawProofWorld(width, height, time);
        if (scene === "editor") drawProofEditor(width, height, time);
        if (scene === "character") drawProofCharacter(width, height, time);
        if (scene === "economy") drawProofEconomy(width, height, time);
        motion.proofFrames[index] = requestAnimationFrame(draw);
      }

      draw(index * 300);
    });
  }

  function setupEngineViewport() {
    const canvas = document.getElementById("engine-viewport");
    if (!canvas || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (motion.engineCanvas === canvas) return;

    if (motion.engineFrame) {
      cancelAnimationFrame(motion.engineFrame);
    }

    motion.engineCanvas = canvas;
    const context = canvas.getContext("2d");
    if (!context) return;

    const nodes = Array.from({ length: 42 }, () => ({
      x: Math.random(),
      y: Math.random(),
      vx: (Math.random() - 0.5) * 0.0008,
      vy: (Math.random() - 0.5) * 0.0008,
      phase: Math.random() * Math.PI * 2
    }));

    canvas.addEventListener("pointermove", (event) => {
      const rect = canvas.getBoundingClientRect();
      motion.enginePointer = {
        x: (event.clientX - rect.left) / rect.width,
        y: (event.clientY - rect.top) / rect.height
      };
    }, { passive: true });

    function resizeViewport() {
      const rect = canvas.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.floor(rect.width * ratio));
      canvas.height = Math.max(1, Math.floor(rect.height * ratio));
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      return { width: rect.width, height: rect.height };
    }

    function drawGrid(width, height, time) {
      context.save();
      context.strokeStyle = "rgba(18, 217, 255, 0.09)";
      context.lineWidth = 1;
      const offset = (time * 0.035) % 32;
      for (let x = -32; x < width + 32; x += 32) {
        context.beginPath();
        context.moveTo(x + offset, 0);
        context.lineTo(x - width * 0.18 + offset, height);
        context.stroke();
      }
      for (let y = -32; y < height + 32; y += 32) {
        context.beginPath();
        context.moveTo(0, y + offset);
        context.lineTo(width, y + offset * 0.6);
        context.stroke();
      }
      context.restore();
    }

    function drawNodes(width, height, time) {
      context.save();
      for (const node of nodes) {
        node.x += node.vx;
        node.y += node.vy;
        if (node.x < 0 || node.x > 1) node.vx *= -1;
        if (node.y < 0 || node.y > 1) node.vy *= -1;
      }
      for (let i = 0; i < nodes.length; i += 1) {
        const a = nodes[i];
        const ax = a.x * width;
        const ay = a.y * height;
        for (let j = i + 1; j < nodes.length; j += 1) {
          const b = nodes[j];
          const bx = b.x * width;
          const by = b.y * height;
          const distance = Math.hypot(ax - bx, ay - by);
          if (distance < 118) {
            context.strokeStyle = `rgba(18, 217, 255, ${(1 - distance / 118) * 0.2})`;
            context.beginPath();
            context.moveTo(ax, ay);
            context.lineTo(bx, by);
            context.stroke();
          }
        }
        const pulse = Math.sin(time * 0.003 + a.phase) * 0.5 + 0.5;
        context.fillStyle = pulse > 0.62 ? "rgba(255, 39, 72, 0.78)" : "rgba(18, 217, 255, 0.72)";
        context.beginPath();
        context.arc(ax, ay, 1.8 + pulse * 1.4, 0, Math.PI * 2);
        context.fill();
      }
      context.restore();
    }

    function drawWorld(width, height, time) {
      context.save();
      const centerX = width * (0.47 + (motion.enginePointer.x - 0.5) * 0.04);
      const centerY = height * (0.55 + (motion.enginePointer.y - 0.5) * 0.04);
      for (let i = 0; i < 7; i += 1) {
        const radius = 44 + i * 29 + Math.sin(time * 0.001 + i) * 5;
        context.strokeStyle = i % 2 ? "rgba(255, 39, 72, 0.24)" : "rgba(18, 217, 255, 0.22)";
        context.lineWidth = i === 3 ? 2 : 1;
        context.beginPath();
        context.ellipse(centerX, centerY, radius * 1.35, radius * 0.62, -0.28, 0, Math.PI * 2);
        context.stroke();
      }
      for (let i = 0; i < 9; i += 1) {
        const angle = time * 0.0007 + i * 0.7;
        const x = centerX + Math.cos(angle) * (88 + i * 7);
        const y = centerY + Math.sin(angle * 1.35) * (44 + i * 3);
        context.fillStyle = i % 3 === 0 ? "rgba(255, 178, 31, 0.9)" : "rgba(18, 217, 255, 0.78)";
        context.fillRect(x - 5, y - 5, 10, 10);
      }
      context.restore();
    }

    function drawStory(width, height, time) {
      context.save();
      const points = [
        [0.15, 0.5], [0.32, 0.28], [0.32, 0.72], [0.52, 0.22],
        [0.55, 0.5], [0.52, 0.78], [0.78, 0.35], [0.82, 0.66]
      ];
      context.lineWidth = 2;
      for (let i = 0; i < points.length - 1; i += 1) {
        const a = points[i];
        for (let j = i + 1; j < points.length; j += 1) {
          if (Math.abs(i - j) > 3) continue;
          const b = points[j];
          context.strokeStyle = `rgba(18, 217, 255, ${0.1 + 0.12 * Math.sin(time * 0.002 + i + j)})`;
          context.beginPath();
          context.moveTo(a[0] * width, a[1] * height);
          context.lineTo(b[0] * width, b[1] * height);
          context.stroke();
        }
      }
      points.forEach((point, index) => {
        const active = Math.sin(time * 0.003 + index) > 0.1;
        context.fillStyle = active ? "rgba(255, 39, 72, 0.92)" : "rgba(18, 217, 255, 0.82)";
        context.fillRect(point[0] * width - 10, point[1] * height - 10, 20, 20);
      });
      context.restore();
    }

    function drawCharacter(width, height, time) {
      context.save();
      const baseX = width * 0.5;
      const baseY = height * 0.58;
      context.strokeStyle = "rgba(18, 217, 255, 0.85)";
      context.lineWidth = 3;
      const sway = Math.sin(time * 0.004) * 8;
      const joints = {
        head: [baseX + sway, baseY - 106],
        chest: [baseX, baseY - 58],
        hip: [baseX, baseY],
        leftHand: [baseX - 72, baseY - 38 + sway],
        rightHand: [baseX + 72, baseY - 38 - sway],
        leftFoot: [baseX - 44, baseY + 86],
        rightFoot: [baseX + 44, baseY + 86]
      };
      [["head", "chest"], ["chest", "hip"], ["chest", "leftHand"], ["chest", "rightHand"], ["hip", "leftFoot"], ["hip", "rightFoot"]].forEach(([a, b]) => {
        context.beginPath();
        context.moveTo(joints[a][0], joints[a][1]);
        context.lineTo(joints[b][0], joints[b][1]);
        context.stroke();
      });
      Object.values(joints).forEach(([x, y], index) => {
        context.fillStyle = index === 0 ? "rgba(255, 39, 72, 0.92)" : "rgba(255, 255, 255, 0.9)";
        context.beginPath();
        context.arc(x, y, index === 0 ? 18 : 8, 0, Math.PI * 2);
        context.fill();
      });
      context.fillStyle = "rgba(255, 178, 31, 0.9)";
      context.fillText("IK / FACE / ABILITY RIG", 28, height - 28);
      context.restore();
    }

    function drawEconomy(width, height, time) {
      context.save();
      const cx = width * 0.52;
      const cy = height * 0.52;
      for (let ring = 0; ring < 4; ring += 1) {
        context.strokeStyle = ring % 2 ? "rgba(255, 39, 72, 0.3)" : "rgba(18, 217, 255, 0.28)";
        context.beginPath();
        context.arc(cx, cy, 42 + ring * 34, 0, Math.PI * 2);
        context.stroke();
      }
      for (let i = 0; i < 18; i += 1) {
        const angle = time * 0.0014 + i * 0.55;
        const radius = 70 + (i % 4) * 28;
        const x = cx + Math.cos(angle) * radius;
        const y = cy + Math.sin(angle) * radius;
        context.fillStyle = i % 2 ? "rgba(255, 178, 31, 0.9)" : "rgba(54, 242, 138, 0.85)";
        context.beginPath();
        context.arc(x, y, 5, 0, Math.PI * 2);
        context.fill();
      }
      context.fillStyle = "rgba(255,255,255,0.95)";
      context.font = "900 36px Arial";
      context.fillText("C30", cx - 34, cy + 12);
      context.restore();
    }

    function drawBuild(width, height, time) {
      context.save();
      const phones = [
        [width * 0.35, height * 0.5, "iOS"],
        [width * 0.65, height * 0.5, "Android"]
      ];
      phones.forEach(([x, y, label], index) => {
        const pulse = Math.sin(time * 0.004 + index) * 0.5 + 0.5;
        context.strokeStyle = index ? "rgba(18, 217, 255, 0.86)" : "rgba(255, 39, 72, 0.86)";
        context.lineWidth = 3;
        context.strokeRect(x - 42, y - 94, 84, 188);
        context.fillStyle = `rgba(18, 217, 255, ${0.08 + pulse * 0.16})`;
        context.fillRect(x - 34, y - 70, 68, 118);
        context.fillStyle = "#fff";
        context.font = "900 18px Arial";
        context.fillText(label, x - 30, y + 78);
      });
      context.fillStyle = "rgba(54, 242, 138, 0.9)";
      context.font = "900 18px Arial";
      context.fillText("EXPORT PIPELINE ACTIVE", 30, height - 30);
      context.restore();
    }

    function draw(time) {
      const { width, height } = resizeViewport();
      const mode = canvas.dataset.engineViewMode || state.engineMode || "world";
      context.clearRect(0, 0, width, height);
      const gradient = context.createRadialGradient(width * 0.6, height * 0.45, 20, width * 0.5, height * 0.5, width * 0.75);
      gradient.addColorStop(0, "rgba(18, 217, 255, 0.16)");
      gradient.addColorStop(0.44, "rgba(255, 39, 72, 0.08)");
      gradient.addColorStop(1, "rgba(0, 0, 0, 0.12)");
      context.fillStyle = gradient;
      context.fillRect(0, 0, width, height);
      drawGrid(width, height, time);
      drawNodes(width, height, time);
      if (mode === "story") drawStory(width, height, time);
      else if (mode === "character") drawCharacter(width, height, time);
      else if (mode === "economy") drawEconomy(width, height, time);
      else if (mode === "build") drawBuild(width, height, time);
      else drawWorld(width, height, time);
      motion.engineFrame = requestAnimationFrame(draw);
    }

    draw(0);
  }

  function initNeuralCanvas() {
    if (motion.canvasReady) return;
    motion.canvasReady = true;
    const canvas = document.getElementById("neural-canvas");
    if (!canvas || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    let width = 0;
    let height = 0;
    let particles = [];
    let pointer = { x: -9999, y: -9999 };

    function resize() {
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.floor(width * ratio);
      canvas.height = Math.floor(height * ratio);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      const count = Math.min(95, Math.max(42, Math.floor(width * height / 16000)));
      particles = Array.from({ length: count }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        vx: (Math.random() - 0.5) * 0.42,
        vy: (Math.random() - 0.5) * 0.42,
        r: Math.random() * 1.8 + 0.8,
        hue: Math.random() > 0.45 ? 190 : 345
      }));
    }

    function draw() {
      context.clearRect(0, 0, width, height);
      context.globalCompositeOperation = "lighter";

      for (const particle of particles) {
        particle.x += particle.vx;
        particle.y += particle.vy;
        if (particle.x < -20) particle.x = width + 20;
        if (particle.x > width + 20) particle.x = -20;
        if (particle.y < -20) particle.y = height + 20;
        if (particle.y > height + 20) particle.y = -20;
      }

      for (let i = 0; i < particles.length; i += 1) {
        const a = particles[i];
        for (let j = i + 1; j < particles.length; j += 1) {
          const b = particles[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const distance = Math.hypot(dx, dy);
          if (distance < 132) {
            const alpha = (1 - distance / 132) * 0.16;
            context.strokeStyle = `rgba(18, 217, 255, ${alpha})`;
            context.lineWidth = 1;
            context.beginPath();
            context.moveTo(a.x, a.y);
            context.lineTo(b.x, b.y);
            context.stroke();
          }
        }

        const pointerDistance = Math.hypot(a.x - pointer.x, a.y - pointer.y);
        if (pointerDistance < 180) {
          context.strokeStyle = `rgba(255, 39, 72, ${(1 - pointerDistance / 180) * 0.38})`;
          context.beginPath();
          context.moveTo(a.x, a.y);
          context.lineTo(pointer.x, pointer.y);
          context.stroke();
        }

        context.fillStyle = a.hue === 190 ? "rgba(18, 217, 255, 0.72)" : "rgba(255, 39, 72, 0.62)";
        context.beginPath();
        context.arc(a.x, a.y, a.r, 0, Math.PI * 2);
        context.fill();
      }

      context.globalCompositeOperation = "source-over";
      requestAnimationFrame(draw);
    }

    window.addEventListener("resize", resize, { passive: true });
    window.addEventListener("pointermove", (event) => {
      pointer = { x: event.clientX, y: event.clientY };
    }, { passive: true });
    window.addEventListener("pointerleave", () => {
      pointer = { x: -9999, y: -9999 };
    }, { passive: true });

    resize();
    draw();
  }
})();
