// ===== 3D 角色：載入 VRM、待機動作、表情、對嘴 =====
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";

// 心情 → VRM 表情權重
const MOOD_FACE = {
  開心: { happy: 0.75 },
  撒嬌: { happy: 0.45, relaxed: 0.35 },
  害羞: { relaxed: 0.55, happy: 0.2, lookDown: 0.25 },
  平靜: { relaxed: 0.15 },
  想睡: { relaxed: 0.5, blink: 0.35 },
  吃醋: { angry: 0.35, sad: 0.15 },
  難過: { sad: 0.7 },
  生氣: { angry: 0.75 },
};

export class Avatar {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(28, 1, 0.1, 50);

    const key = new THREE.DirectionalLight(0xffffff, 1.5);
    key.position.set(1.2, 2.2, 2.5);
    const fill = new THREE.DirectionalLight(0xffe2ec, 0.6);
    fill.position.set(-2, 1.2, 1.5);
    const rim = new THREE.DirectionalLight(0xbfd8ff, 1.1);
    rim.position.set(0, 2, -2.5);
    this.scene.add(key, fill, rim, new THREE.AmbientLight(0xffffff, 0.35));

    // 地面柔和陰影
    const shadowTex = (() => {
      const c = document.createElement("canvas"); c.width = c.height = 128;
      const g = c.getContext("2d"), grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
      grd.addColorStop(0, "rgba(0,0,0,.35)"); grd.addColorStop(1, "rgba(0,0,0,0)");
      g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
      return new THREE.CanvasTexture(c);
    })();
    const shadow = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.9),
      new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false }));
    shadow.rotation.x = -Math.PI / 2; shadow.position.y = 0.002;
    this.scene.add(shadow);

    this.vrm = null;
    this.clock = new THREE.Clock();
    this.t = 0;
    this.face = {};            // 目前表情權重
    this.faceTarget = MOOD_FACE["平靜"];
    this.mouthLevel = () => 0; // 由外部提供（音量）
    this.thinking = false;
    this.nodTime = -10;
    this.nextBlink = 2;
    this.blinkT = -1;
    this.pointer = new THREE.Vector2();
    this.framing = "full";     // full | half
    this.camPos = new THREE.Vector3(); this.camLook = new THREE.Vector3();

    addEventListener("pointermove", (e) => {
      this.pointer.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    });
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
    this.renderer.setAnimationLoop(() => this.update());
  }

  async load(source) {
    const loader = new GLTFLoader();
    loader.register((p) => new VRMLoaderPlugin(p));
    const gltf = typeof source === "string"
      ? await loader.loadAsync(source)
      : await loader.parseAsync(source, "");
    const vrm = gltf.userData.vrm;
    if (!vrm) throw new Error("這不是 VRM 模型檔");
    if (this.vrm) { this.scene.remove(this.vrm.scene); VRMUtils.deepDispose(this.vrm.scene); }
    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    VRMUtils.combineSkeletons?.(gltf.scene);
    if (vrm.meta?.metaVersion === "0") VRMUtils.rotateVRM0(vrm);
    vrm.scene.traverse((o) => { o.frustumCulled = false; });
    this.scene.add(vrm.scene);
    this.vrm = vrm;

    const head = vrm.humanoid.getNormalizedBoneNode("head");
    const box = new THREE.Box3().setFromObject(vrm.scene);
    this.height = box.max.y;
    this.headY = head ? head.getWorldPosition(new THREE.Vector3()).y : this.height * 0.9;
    this.face = {};
    this.frame(true);
  }

  setMood(mood) { this.faceTarget = MOOD_FACE[mood] || MOOD_FACE["平靜"]; }
  nod() { this.nodTime = this.t; }
  toggleFraming() { this.framing = this.framing === "full" ? "half" : "full"; this.frame(); }

  resize() {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.frame(true);
  }

  // 依畫面比例計算鏡頭距離，讓全身（或半身）剛好入鏡
  frame(snap = false) {
    if (!this.vrm) return;
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    let top, bottom;
    if (this.framing === "full") { top = this.height + 0.08; bottom = -0.05; }
    else { top = this.height + 0.06; bottom = this.headY - 0.62; }
    // 下方保留字幕和輸入框的空間，讓她的腳不被擋住
    const H = this.canvas.clientHeight || 800;
    const uiFrac = Math.min(0.32, 170 / H), topFrac = this.framing === "full" ? Math.min(0.12, 70 / H) : 0;
    const body = top - bottom, total = body / (1 - uiFrac - topFrac);
    top = top + total * topFrac;
    bottom = top - total;
    const span = top - bottom, center = (top + bottom) / 2;
    const halfW = 0.55 * (this.framing === "full" ? 1 : 0.8);
    const distH = span / 2 / Math.tan(fov / 2);
    const distW = halfW / (Math.tan(fov / 2) * this.camera.aspect);
    const dist = Math.max(distH, distW) * 1.04;
    this.camPos.set(0, center + 0.02, dist);
    this.camLook.set(0, center, 0);
    if (snap) { this.camera.position.copy(this.camPos); this.camera.lookAt(this.camLook); }
  }

  update() {
    const dt = Math.min(this.clock.getDelta(), 0.1);
    this.t += dt;
    const t = this.t;
    // 鏡頭平滑移動
    this.camera.position.lerp(this.camPos, 1 - Math.pow(0.02, dt));
    this.camera.lookAt(this.camLook);

    const vrm = this.vrm;
    if (vrm) {
      const bone = (n) => vrm.humanoid.getNormalizedBoneNode(n);
      const breathe = Math.sin(t * 1.6);
      const sway = Math.sin(t * 0.45);

      // 手臂自然垂下，隨呼吸微動
      const lua = bone("leftUpperArm"), rua = bone("rightUpperArm");
      const lla = bone("leftLowerArm"), rla = bone("rightLowerArm");
      if (lua) lua.rotation.set(0.05, 0, -1.22 + breathe * 0.015);
      if (rua) rua.rotation.set(0.05, 0, 1.22 - breathe * 0.015);
      if (lla) lla.rotation.set(0, -0.18, -0.12);
      if (rla) rla.rotation.set(0, 0.18, 0.12);
      const lh = bone("leftHand"), rh = bone("rightHand");
      if (lh) lh.rotation.set(0, 0, -0.08);
      if (rh) rh.rotation.set(0, 0, 0.08);

      // 重心左右移動、呼吸
      const hips = bone("hips");
      if (hips) { hips.rotation.z = sway * 0.025; hips.position.x = sway * 0.012; }
      const spine = bone("spine"), chest = bone("chest") || bone("upperChest");
      if (spine) spine.rotation.set(breathe * 0.012, 0, -sway * 0.02);
      if (chest) chest.rotation.x = breathe * 0.018;

      // 頭：看向游標、點頭、思考時歪頭
      const head = bone("head"), neck = bone("neck");
      const nodP = t - this.nodTime;
      const nod = nodP < 0.7 ? Math.sin((nodP / 0.7) * Math.PI) * 0.16 : 0;
      const tilt = this.thinking ? 0.12 + Math.sin(t * 1.2) * 0.02 : Math.sin(t * 0.7) * 0.02;
      const talk = this.mouthLevel();
      if (head) {
        const tx = -this.pointer.y * 0.18 + nod + talk * 0.05 * Math.sin(t * 7);
        const ty = this.pointer.x * 0.35;
        head.rotation.x += (tx - head.rotation.x) * Math.min(1, dt * 5);
        head.rotation.y += (ty - head.rotation.y) * Math.min(1, dt * 3);
        head.rotation.z += (tilt - head.rotation.z) * Math.min(1, dt * 3);
      }
      if (neck) neck.rotation.y = (head?.rotation.y || 0) * 0.3;

      // 表情平滑過渡
      const em = vrm.expressionManager;
      if (em) {
        const names = ["happy", "angry", "sad", "relaxed", "surprised", "lookDown"];
        for (const n of names) {
          const target = this.faceTarget[n] || 0;
          this.face[n] = (this.face[n] || 0) + (target - (this.face[n] || 0)) * Math.min(1, dt * 3);
          em.setValue(n, this.face[n]);
        }
        // 眨眼
        if (t > this.nextBlink && this.blinkT < 0) this.blinkT = 0;
        let blink = this.faceTarget.blink || 0;
        if (this.blinkT >= 0) {
          this.blinkT += dt;
          blink = Math.max(blink, Math.sin(Math.min(this.blinkT / 0.16, 1) * Math.PI));
          if (this.blinkT > 0.16) { this.blinkT = -1; this.nextBlink = t + 2 + Math.random() * 4; }
        }
        // 開心表情本身會瞇眼，避免和眨眼疊加過度
        em.setValue("blink", Math.min(1, blink * (1 - (this.face.happy || 0) * 0.6)));
        // 對嘴：音量 → aa / oh 交替
        em.setValue("aa", Math.min(1, talk * 1.1));
        em.setValue("oh", Math.min(1, talk * 0.4 * (0.5 + 0.5 * Math.sin(t * 9))));
      }
      vrm.update(dt);
    }
    this.renderer.render(this.scene, this.camera);
  }
}
