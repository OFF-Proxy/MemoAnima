// L-2: 中国語（簡体字）辞書。**このファイルは機械が生成します。手で編集しないでください。**
//
//   npx tsx scripts/import_translation.ts <対照表CSV> zh-Hans
//
//  - 入力は対照表 CSV の「キー」列と訳文の列だけ。**空欄の行は書き出しません**
//    ＝**部分辞書**。届いた行から順に載せられる（作り直さないこと・REQ_L2_zh §1）
//  - 未訳キーは `index.ts` の `lookup()` が **en → ja** の順に落とします
//    （「未訳で日本語が出るより英語が出るほうがよい」）
//  - 並びは `ja.ts` と同じ（画面ごとのまとまり順）。1行1エントリ
//  - 型は `Partial<…>`＝**1キーも無くてもコンパイルは通る**（キー集合の正は `ja.ts`）
import type ja from "./ja";

const zhHans: Partial<Record<keyof typeof ja, string>> = {
};

export default zhHans;
