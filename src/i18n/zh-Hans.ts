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
  // V151: 新キー12個の**ドラフト訳**（Code 作・指示による例外。訳者の CSV が届いたら import で上書きされる想定。
  // 対照表への追記は docs/i18n/SHEET_DELTA_zh.md §B-2 に記録済み。※再 import 時、CSV にこの12行が
  // 無い（または空欄）とドラフトごと消えて en に落ちるので、B-2 の12行を CSV に足してから流し込むこと）
  "img.dialog.frames.hint": "{n} 张 → {n} 帧（插入到当前帧之后）",
  "img.manyConfirm.msg": "将导入 {n} 张图片。转换可能需要一些时间。继续吗？",
  "ed.img.place.sharedBlocked.toast": "无法将序列图放到全帧共用图层（📌）上（请先取消共用）",
  "img.placeFrames.btn": "在后面插入帧",
  "set.confirms.label": "确认对话框",
  "set.confirms.clearFrame.label": "🌀 清除时确认",
  "set.confirms.layerDelete.label": "删除图层时确认",
  "set.confirms.folderDelete.label": "删除文件夹时确认",
  "set.confirms.hint": "隐藏的确认可以随时在这里恢复",
  "common.dontShowAgain.label": "下次不再显示",
  "guide.recent.label": "最近新增的功能",
  "guide.recent.msg": "全帧共用图层（📌）、图层颜色、◯圈内填充、工具条、我的图案、逐帧错位、Alt+点击取色、MP4 循环导出、批量导入序列图（用 📷 选择多张）等。",
};

export default zhHans;
