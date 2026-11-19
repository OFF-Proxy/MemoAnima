// V227 (X-1・UI §5-9 の最後の★): 箱が出ている間は、その後ろを押せなくする（`inert`）。
//
// ★対象: 確認・お知らせの箱・選ばせる・名前の欄の島・保存先・戻るときの確認・小窓（どれも ui/dialogs.ts の openDialog）／設定の画面／
//  「開いています」「◯◯しています」の箱。重なったときは一番上だけが押せる（下にある別の箱・描く画面・ライブラリは押せない）。
// ★やり方: 一番上の箱から body まで親をたどり、その道の兄弟を全部 `inert` にする。箱そのものと、その親（箱を置く層・body）は
//  `inert` にしない（親を `inert` にすると箱ごと押せなくなる）。
// ★閉じたら、開く前の状態へ正確に戻す: 触った要素ごとに「触る前の値」を覚え、上が替わるたびに全部戻してから、新しい一番上で付け直す。
//  （設定の画面の上に確認が出て、確認だけ閉じたとき＝設定の後ろは `inert` のまま・設定そのものは押せる）
// ★画面を持たない決まり（どれを `inert` にするか）は backgroundOf に出す（scripts/v227_smoke.ts [X] が偽の木で動かす）。
// ★箱の出方・Esc と Enter・外から閉じる口（closeTopDialog）の答えは変えない（ここはフォーカスと押せる所だけを変える）。

/** 決まりに要る形（本物の Element と、検査の偽の木の両方） */
export interface InertNode {
  parentElement: InertNode | null;
  readonly children: ArrayLike<InertNode>;
  inert: boolean;
}

/** `inert` にしないもの（開発用の札など・呼ぶ側が登録する）。検査と確かめ画面のためだけの口で、製品の画面は登録しない */
const exempt = new WeakSet<object>();
export function keepLive(el: object): void {
  exempt.add(el);
}

/** 一番上の箱 top の「後ろ」＝ top から根までの道の兄弟（道そのものは含まない）。stopAt（body）の親より上は見ない */
export function backgroundOf(top: InertNode, stopAt: InertNode | null): InertNode[] {
  const out: InertNode[] = [];
  let n: InertNode = top;
  while (n !== stopAt && n.parentElement) {
    const p: InertNode = n.parentElement;
    for (let i = 0; i < p.children.length; i++) {
      const s = p.children[i];
      if (s !== n && !exempt.has(s)) out.push(s);
    }
    n = p;
  }
  return out;
}

/** 出ている箱（後ろが上） */
const stack: InertNode[] = [];
/** 触った要素と、触る前の値 */
const touched = new Map<InertNode, boolean>();
let root: InertNode | null = null;

/** 検査用: 根（body の代わり）を差し替える */
export function setInertRoot(r: InertNode | null): void {
  root = r;
}

function rootNode(): InertNode | null {
  if (root) return root;
  return typeof document !== "undefined" ? (document.body as unknown as InertNode) : null;
}

function apply(): void {
  // 先に全部戻す（触る前の値へ）
  for (const [el, was] of touched) el.inert = was;
  touched.clear();
  const top = stack[stack.length - 1];
  if (!top) return;
  for (const el of backgroundOf(top, rootNode())) {
    if (!touched.has(el)) touched.set(el, el.inert);
    el.inert = true;
  }
}

/** 箱を出した（置いたあとで呼ぶ）。返り値で外す（何度呼んでも 1 回だけ効く） */
export function holdBackground(box: InertNode): () => void {
  stack.push(box);
  apply();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const i = stack.lastIndexOf(box);
    if (i >= 0) stack.splice(i, 1);
    apply();
  };
}

/** いま出ている箱の数（検査と確かめ画面） */
export function heldCount(): number {
  return stack.length;
}
