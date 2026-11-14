// V226 (H-1・DU-3 は A): Android だけの見た目の入れ口（app.ts が Android のときだけ動的 import する＝iOS では読まれない）。
//
// - ルート（<html>）に印のクラス `mb-android` を付け、Android だけの CSS（android.css）を読む。
// - android.css は「押せるものの当たりを 48dp に広げる」だけ（見た目の大きさと位置は変えない）。
//   editor.css・screens.css・mobile.css は変えない（iOS と共通）。
import "./android.css";

/** Android のときだけルートに付く印のクラス */
export const ANDROID_CLASS = "mb-android";

export function applyAndroidLook(doc: Document = document): void {
  doc.documentElement.classList.add(ANDROID_CLASS);
}
