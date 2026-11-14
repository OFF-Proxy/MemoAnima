// V225 (M-2b-3b-2・親§6-8・D-M2-2・C16・指示書 ■3 の K): モバイルのハードウェアキーボードの受け手（画面を持たない）。
//
// ★§5-0 の一時的な写し（PC のファイルは Mac の作業では変えられない＝決-12。次の Windows の作業で共通へ移す）:
//    元: src/editor/editor.ts の keydownHandler・keyupHandler・blurHandler・onKeyDown・handleModTapUp・trackModTapDown・
//        pickCommandFromIds・handleArrowKey・runCommand（コアが受けないコマンドの枝）
//    写した所: このファイルの KeyboardHandler（down・up・blur・pointerDown）と MOBILE_COMMANDS
//    比べ方: scripts/v225_smoke.ts [K]（標準と左手向けの全部のキーで、呼ぶコマンドが buildLookup の答えと同じ・巡回・押しっぱなし・
//            くり返し・二重の発火・変換中・修飾キーだけのタップ・入力欄の中・Space・片付け）
// ★割り当ては PC のプリセット（標準・左手向け）。照合は keymap.ts の buildLookup と eventKey（⌘ は platform.ts の primaryMod が
//  Ctrl に畳む＝入口が渡した OS が ios でも isMacPlatform() が true）。コマンドの中身はコアの口（runCoreCommand・escapeKey・enterKey・
//  backspaceKey・nudgeArrow）。コアが受けないコマンドは MOBILE_COMMANDS の表で受ける。
// ★pointerType を読まない。DOM を読まない（出来事の形だけを受ける＝Node の検査で回る）。画面にキーの表記は出さない（U-12）。
import { COMMANDS, ModTapWatcher, buildLookup, eventKey, isHoldOnlyCommand, tapEventKey, type CommandId, type Preset } from "../../keymap";
import { isMacPlatform, primaryMod } from "../../platform";

/** 受け取るキーの出来事（KeyboardEvent の形。textEntry＝入力欄の中・onButton＝ボタンかリンクにフォーカスがある） */
export interface KeyEventLike {
  key: string;
  code: string;
  repeat: boolean;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  isComposing: boolean;
  keyCode: number;
  textEntry: boolean;
  onButton: boolean;
  preventDefault(): void;
}

/** 描く画面が渡す口 */
export interface KeyEnv {
  /** 描く画面が開いている */
  mounted(): boolean;
  /** 確認の箱・設定の画面・案内が出ている（その間は描く画面のコマンドを効かせない） */
  blocked(): boolean;
  /** 描いている（振り分け層が描く口に回した接触がある） */
  pointerDown(): boolean;
  /** いまのツール（同じキーに並ぶツールの巡回） */
  tool(): string;
  /** 全レイヤーの束を確定する（コアの settleEraseAll） */
  settleEraseAll(): void;
  /** 矢印の移動のまとめを確定する（コアの endArrowSession） */
  endArrowSession(): void;
  /** Esc: 先に画面の側（帯・一覧・その他・コマの帯・行やコマを運んでいる途中）。受けたら true */
  escapeUi(): boolean;
  /** コアの決まったキー */
  escapeKey(): void;
  backspaceKey(repeat: boolean): boolean;
  enterKey(primary: boolean): boolean;
  nudgeArrow(dx: number, dy: number): boolean;
  /** コマンドを走らせる（コアの runCoreCommand → 受けなければ MOBILE_COMMANDS） */
  run(id: CommandId): void;
  togglePlayback(): void;
  /** Space を押している間（1 本の接触で絵を動かす＝振り分け層の pan） */
  spaceHeld(on: boolean): void;
  /** 変形の「下を見る」（押している間だけ） */
  peek(on: boolean): void;
  peeking(): boolean;
  /** フォーカスを失った: 接触の残りを畳む（描いている線はそこまでで確定） */
  pointerSessionEnd(): void;
  now(): number;
}

/** 矢印キーで動かす量（Shift で 10＝PC の ARROW_BIG_STEP） */
export const ARROW_BIG_STEP = 10;
/** Space をすぐ離したとみなす時間（PC の SPACE_TAP_MS） */
export const SPACE_TAP_MS = 250;
/** 短い間の二重の発火を捨てる（PC の DOUBLE_FIRE_MS） */
export const DOUBLE_FIRE_MS = 50;
/** 描きながら押さえて使うキー（全レイヤーの束を確定しない＝PC の HELD_WHILE_DRAWING） */
export const HELD_WHILE_DRAWING: ReadonlySet<string> = new Set(["Shift", "Control", "Alt", "Meta", " "]);
/** 押しっぱなしでくり返してよいコマンド（PC の REPEATABLE と同じ作り方） */
export const REPEATABLE: ReadonlySet<string> = new Set(COMMANDS.filter((c) => (c as { repeatable?: boolean }).repeatable).map((c) => c.id));

/**
 * ★コアの runCoreCommand が受けないコマンドを、モバイルでどうするか（PC は editor.ts の runCommand と main.ts）。
 *  値＝モバイルの画面の口の名前（mobileEditor.ts の mbRunCommand が同じ名前で受ける）・null＝何もしない。どの行にも、行の終わりの注釈に理由を書く。
 *  scripts/v225_smoke.ts [K] が「COMMANDS のうちコアが受けないもの全部がここに載っている」を見る。
 */
export const MOBILE_COMMANDS: Readonly<Record<string, string | null>> = {
  "edit.pickColor": null, // PC は修飾キー＋クリックで 1 回拾う（ポインタの割り当て）。モバイルは長押しのスポイト（親§6-3）
  "file.save": "save", // 保存（右の列の保存と同じ道）
  "file.saveAs": "saveAs", // 別名で保存（その他のメニューと同じ道）
  "file.export": null, // 書き出しは M-4（画面の札も押せない）
  "file.image": null, // 画像の取り込みは M-4（その他のメニューの札も押せない）
  "file.audio": null, // 音声は M-4（その他のメニューの札も押せない）
  "app.settings": "settings", // 設定を開く（その他のメニューの［設定］と同じ道）
  "frame.wobble": "wobble", // ゆらゆら（広げたタイムラインの札と同じ小窓）
  "play.loop": "loop", // ループ（広げたタイムラインの頭の札と同じ）
  "view.zoomIn": "zoomIn", // 倍率を 1 段上げる（寄る刻み・×32 まで）
  "view.zoomOut": "zoomOut", // 倍率を 1 段下げる（寄る刻み・fit まで）
  "view.rotate": "rotate", // 表示を 90° 回す（PC の回転のボタンと同じ 4 方向）
  "view.flip": "flip", // 表示を左右反転（表示のパネルのスイッチと同じ）
  "xform.peek": "peek", // 押している間だけ下を見る（変形の帯の札と同じ・離したら戻す）
  "view.miniToggle": "mini", // ミニプレビュー（表示のパネルのスイッチと同じ）
  "view.focusToggle": "focus", // ツールを隠す・表示する（下の帯のボタンと同じ）
};

/** 同じキーに並ぶツールの巡回（PC の pickCommandFromIds と同じ規則: いまのツールが並びにあれば次へ・無ければ先頭） */
export function pickCommandFromIds(ids: readonly CommandId[], tool: string): CommandId {
  if (ids.length <= 1) return ids[0];
  const at = ids.indexOf(`tool.${tool}` as CommandId);
  return at >= 0 ? ids[(at + 1) % ids.length] : ids[0];
}

export class KeyboardHandler {
  private lookup = new Map<string, CommandId[]>();
  private modTap: ModTapWatcher;
  private space = false;
  private spaceDownAt = 0;
  private spacePanned = false;
  /** 下を見始めたときのキー（そのキーを離したら戻す）と、いま走らせているコマンドのキー（PC の peekCode・peekPendingCode） */
  private peekCode: string | null = null;
  private pendingCode: string | null = null;
  private lastCommandAt = new Map<string, number>();

  constructor(private env: KeyEnv) {
    this.modTap = new ModTapWatcher(() => env.now());
  }

  /** 割り当てを替える（設定の画面から切り替えたときも同じ入口＝PC の applyKeyPreset） */
  setPreset(preset: Preset): void {
    this.lookup = buildLookup(preset);
  }

  /** Space を押しているか（振り分け層の pan の入力） */
  spaceIsHeld(): boolean {
    return this.space;
  }
  /** Space を押している間に絵を動かした（すぐ離しても再生にしない＝PC の spacePanned） */
  notePanned(): void {
    if (this.space) this.spacePanned = true;
  }
  /** ポインタが下りた（修飾キーだけのタップの候補を捨てる） */
  pointerDown(): void {
    this.modTap.cancel();
  }

  private stopped(e: KeyEventLike): boolean {
    return !this.env.mounted() || this.env.blocked() || e.textEntry;
  }

  /** ★押した（PC の keydownHandler → onKeyDown の順） */
  down(e: KeyEventLike): void {
    const env = this.env;
    // 修飾キーだけのタップの候補（発動は離したとき）
    this.modTap.down(e.key, {
      repeat: e.repeat,
      blocked: !env.mounted() || env.pointerDown() || env.blocked() || e.textEntry || e.isComposing || e.keyCode === 229,
      mods: e,
    });
    if (!env.mounted()) return;
    if (env.blocked()) return;
    if (e.textEntry) return;
    if (e.isComposing || e.keyCode === 229) return;
    if (!e.repeat && !HELD_WHILE_DRAWING.has(e.key)) env.settleEraseAll();

    if (e.code === "Space") {
      e.preventDefault();
      if (!e.repeat) {
        env.endArrowSession();
        this.space = true;
        this.spaceDownAt = env.now();
        this.spacePanned = false;
        env.spaceHeld(true);
      }
      return;
    }
    if (e.code === "Escape") {
      if (env.escapeUi()) return;
      env.escapeKey();
      return;
    }
    if (e.code.startsWith("Arrow")) {
      const step = e.shiftKey ? ARROW_BIG_STEP : 1;
      const dx = e.code === "ArrowLeft" ? -step : e.code === "ArrowRight" ? step : 0;
      const dy = e.code === "ArrowUp" ? -step : e.code === "ArrowDown" ? step : 0;
      if (env.nudgeArrow(dx, dy)) e.preventDefault();
      return;
    }
    if (e.code === "Backspace") {
      if (env.backspaceKey(e.repeat)) {
        e.preventDefault();
        return;
      }
    }
    if (e.code === "Enter" || e.code === "NumpadEnter") {
      if (env.enterKey(primaryMod(e))) {
        e.preventDefault();
        return;
      }
      if (e.onButton) return;
    }

    const ids = this.lookup.get(eventKey(e as unknown as KeyboardEvent));
    if (!ids || ids.length === 0) return;
    let id: CommandId = ids[0];
    if (ids.length > 1) {
      if (e.repeat) return this.swallowRepeat(e);
      id = pickCommandFromIds(ids, env.tool());
    }
    if (e.repeat && !REPEATABLE.has(id)) return this.swallowRepeat(e);
    e.preventDefault();
    if (!e.repeat) {
      const now = env.now();
      const prev = this.lastCommandAt.get(id);
      if (prev !== undefined && now - prev < DOUBLE_FIRE_MS) return;
      this.lastCommandAt.set(id, now);
    }
    // 「押している間だけ」のコマンドのために、いま押されているキーを控える（下を見始めたら、そのキーを離したときに戻す）
    this.pendingCode = e.code;
    env.endArrowSession();
    const was = env.peeking();
    env.run(id);
    if (!was && env.peeking()) this.peekCode = this.pendingCode;
  }

  /** 一致した打鍵を、押しっぱなしのくり返しだから走らせないとき（PC の swallowRepeatOnMac。iPad も ⌘ の既定の動きへ回さない） */
  private swallowRepeat(e: KeyEventLike): void {
    if (isMacPlatform()) e.preventDefault();
  }

  /** ★離した（PC の keyupHandler） */
  up(e: KeyEventLike): void {
    const env = this.env;
    const tap = this.modTap.up(e.key);
    if (tap && env.mounted() && !env.blocked() && !e.textEntry && !env.pointerDown()) {
      const ids = this.lookup.get(tapEventKey(tap));
      if (ids && ids.length > 0) {
        const id = pickCommandFromIds(ids, env.tool());
        if (!isHoldOnlyCommand(id)) {
          const now = env.now();
          const prev = this.lastCommandAt.get(id);
          if (!(prev !== undefined && now - prev < DOUBLE_FIRE_MS)) {
            this.lastCommandAt.set(id, now);
            env.endArrowSession();
            env.run(id);
          }
        }
      }
    }
    if (e.key === " ") {
      const wasHeld = this.space;
      const held = env.now() - this.spaceDownAt;
      const panned = this.spacePanned;
      this.space = false;
      this.spacePanned = false;
      env.spaceHeld(false);
      if (wasHeld && !panned && held <= SPACE_TAP_MS && !this.stopped(e)) env.togglePlayback();
    }
    if (env.peeking() && (this.peekCode === null || e.code === this.peekCode)) env.peek(false);
  }

  /** ★フォーカスを失った（PC の blurHandler）: 候補を捨てる・Space をおろす・透かしを戻す・接触を畳む */
  blur(): void {
    const env = this.env;
    if (!env.mounted()) return;
    this.modTap.cancel();
    this.space = false;
    this.spacePanned = false;
    env.spaceHeld(false);
    env.peek(false);
    env.pointerSessionEnd();
  }

  /** 作品を閉じる・設定の画面を出す: 押しっぱなしの状態を畳む（接触は呼ぶ側が畳む） */
  reset(): void {
    this.modTap.cancel();
    this.space = false;
    this.spacePanned = false;
    this.env.spaceHeld(false);
    if (this.env.peeking()) this.env.peek(false);
  }
}
