// V224 (A-4・D-M1-7): scripts/mobile_build.ts が src-tauri/gen/android の MainActivity.kt をこの中身に置き換える
// （ひな形〔tauri android init〕か、前の回のこのファイルの中身のときだけ。違えば止める）。ひな形の 2 行（enableEdgeToEdge・super.onCreate）はそのまま。
// ★V224 で足したのは、戻るボタンの最後の受け手: 画面（JS）が戻るボタンを受けていない間（古い Android System WebView の画面・起動の途中）は、
//  Tauri の AppPlugin が Activity の onBackPressed へ回す → ここで Activity を閉じずに裏へ回す（V212: 閉じると、Activity が壊れたあと
//  ネイティブで落ちていた）。画面が受けている間（onBackButtonPress）は、AppPlugin が先に受けるので、ここには来ない
// ★V226: Activity が作り直されたあとは AppPlugin の受け口が付かず、戻るボタンはいつも最後の受け手に来る（エミュレーターで確かめた）。
//  最後の受け手は、画面が置いた受け手（window.__mbAndroidBack＝androidGlue.ts）があれば渡し、無ければ裏へ回す
// ★V226 (T-1・D-M2-6): 一番短い辺が 600dp 以上の端末（タブレット）では、時計と電池の帯を隠す（端からのスワイプで一時的に出せる＝OS の標準の出し方）。
//  下のナビゲーションの帯（ジェスチャーの線・3 つのボタン）は隠さない。スマホ（600dp 未満）は隠さない。
//  端末の大きさで決める（窓の大きさではない＝画面分割で窓が狭くなっても、同じ端末なら同じ扱い）。
// ★V226 (T-2): API 35 からはアプリが画面の端まで描く。見えている帯（下のナビゲーションの帯・スマホの上の帯・切り欠き）の分だけ
//  画面（WebView）を内側に置く＝下の帯やライブラリの操作が、ナビゲーションの帯に隠れない。画面の側（CSS・倍率の計算）は、
//  「帯を除いた大きさの画面」として今までどおり動く。文字の入力のキーボードが出ている間は、その分も内側に置く。帯の後ろは黒（配色〔明るい紙・夜の紙〕は OS に伝えていないので、どちらでも同じ色にする）
package com.arcana.memoanima

import android.graphics.Color
import android.os.Bundle
import android.util.DisplayMetrics
import android.view.View
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

class MainActivity : TauriActivity() {
  companion object {
    /** タブレットとして扱う、端末の一番短い辺（dp） */
    const val TABLET_MIN_DP = 600
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    // 先に足した受け手ほど後に呼ばれる（AppPlugin の受け手より後＝最後の受け手）
    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        backFromFallback()
      }
    })
    super.onCreate(savedInstanceState)
    window.decorView.setBackgroundColor(Color.BLACK)
    val content = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { v, insets ->
      // 見えている帯の分だけ内側へ（隠れている帯は 0）。文字の入力のキーボード（IME）が出ている間は、その分も内側へ
      // （端まで描く形では OS が画面を縮めないので、縮めないと名前の欄の箱のボタンがキーボードの下に隠れる＝エミュレーターで確かめた）
      val bars = WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime()
      val i = insets.getInsets(bars)
      v.setPadding(i.left, i.top, i.right, i.bottom)
      WindowInsetsCompat.Builder(insets).setInsets(bars, Insets.NONE).build()
    }
    applyBars()
  }

  // ★V226: 画面（WebView）。最後の受け手が、画面の受け手（window.__mbAndroidBack）へ渡すのに使う
  private var web: WebView? = null

  override fun onWebViewCreate(webView: WebView) {
    web = webView
  }

  /** 最後の受け手。Activity が作り直されたあと（密度・文字の大きさ・ナビゲーションの形を変えたあと）は、Tauri の受け口（AppPlugin）が
   *  新しい Activity に付かないので、戻るボタンはいつもここに来る。画面が受け手を置いていれば渡し（開いているものを先に閉じる順は画面の側）、
   *  置いていなければ（古い WebView の画面・起動の途中）今までどおり Activity を閉じずに裏へ回す */
  private fun backFromFallback() {
    val w = web
    if (w == null) {
      moveTaskToBack(true)
      return
    }
    w.evaluateJavascript("(function(){try{if(typeof window.__mbAndroidBack==='function'){window.__mbAndroidBack();return 1}}catch(e){}return 0})()") { r ->
      if (r != "1") moveTaskToBack(true)
    }
  }

  /** 端末の一番短い辺（dp）。窓ではなく画面そのものの大きさ */
  private fun deviceSmallestDp(): Float {
    val m = DisplayMetrics()
    @Suppress("DEPRECATION")
    windowManager.defaultDisplay.getRealMetrics(m)
    return minOf(m.widthPixels, m.heightPixels) / m.density
  }

  /** タブレットなら時計と電池の帯を隠す。ナビゲーションの帯には触らない（statusBars だけ） */
  private fun applyBars() {
    val c = WindowCompat.getInsetsController(window, window.decorView)
    c.isAppearanceLightStatusBars = false
    c.isAppearanceLightNavigationBars = false
    if (deviceSmallestDp() >= TABLET_MIN_DP) {
      c.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
      c.hide(WindowInsetsCompat.Type.statusBars())
    } else {
      c.show(WindowInsetsCompat.Type.statusBars())
    }
  }

  // 回転・画面分割・裏から戻ったあとも同じ形に（OS が帯を出し直すことがある）
  override fun onWindowFocusChanged(hasFocus: Boolean) {
    super.onWindowFocusChanged(hasFocus)
    if (hasFocus) applyBars()
  }

  override fun onResume() {
    super.onResume()
    applyBars()
  }
}
