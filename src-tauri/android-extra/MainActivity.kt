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
// ★V229 (M-4): 出し入れ（共有・保存・選ぶ・受け取り）を足した（下の「出し入れ」の節・MemoAnimaIoProvider）。マニフェストの intent-filter と
//  FileProvider は scripts/mobile_build.ts が当てる（patchIoManifest）
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
    // ★V229: 選ぶ・保存の途中で Activity が作り直されたら、待っている要求を引き継ぐ。初めての作成なら受け取りの intent を扱う
    if (savedInstanceState != null) {
      ioReq = savedInstanceState.getString("memoanima.io.req")
      ioKind = savedInstanceState.getString("memoanima.io.kind")
      ioSaveFrom = savedInstanceState.getString("memoanima.io.saveFrom")
    } else {
      ioHandleIntent(intent)
    }
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

  // ======================= ★V229 (M-4・REQ_mobile_m4_io.md §4): 出し入れ =======================
  // 共有（ACTION_SEND）・保存（ACTION_CREATE_DOCUMENT）・選ぶ（ACTION_OPEN_DOCUMENT・PickVisualMedia）・受け取り（VIEW・SEND・SEND_MULTIPLE）。
  // ・Rust（commands.rs の mobile_out_share・mobile_out_save・mobile_in_pick）が JNI でここの io* を主スレッドで呼ぶ。結果は
  //   window.__mbIoDone(req, 結果) で画面へ返す（共有は開けたら "shared"・保存は "saved"／"cancelled"／"failed"・選ぶは InItem の配列）。
  // ・選んだ・受け取ったファイルは cacheDir/memoanima-io/in/<名札>/data へストリームで写す（全部をメモリに読まない）。meta.json に表示名と大きさ。
  //   受け取りは印 recv も置く（Rust の mobile_in_received が印を taken に変えたものだけを返す＝1 回の受け取りは 1 回だけ）。
  // ・写している途中で大きさの門番（作品 512MiB・画像と音 64MiB）を超えたら止めて消す。元のファイルには書かない・永続の許可は取らない。
  // ・受け取りで file:// と、このアプリ自身の FileProvider の URI を断る（記録に 1 行・名前と URI は書かない）。
  // ・HEIC（写真）は ImageDecoder で PNG にしてから渡す（WebView で読めない）。向きは ImageDecoder が写真アプリと同じにそろえる。

  private val ioMain = android.os.Handler(android.os.Looper.getMainLooper())
  private var ioReq: String? = null
  private var ioKind: String? = null
  private var ioSaveFrom: String? = null

  private val ioDocs = registerForActivityResult(androidx.activity.result.contract.ActivityResultContracts.StartActivityForResult()) { r ->
    val req = ioReq ?: return@registerForActivityResult
    ioReq = null
    val uris = mutableListOf<android.net.Uri>()
    val data = r.data
    if (r.resultCode == RESULT_OK && data != null) {
      val clip = data.clipData
      if (clip != null) for (i in 0 until clip.itemCount) clip.getItemAt(i).uri?.let { uris.add(it) }
      else data.data?.let { uris.add(it) }
    }
    ioCopyAndReport(req, ioKind ?: "works", uris, false)
  }
  private val ioPhotoOne = registerForActivityResult(androidx.activity.result.contract.ActivityResultContracts.PickVisualMedia()) { u ->
    val req = ioReq ?: return@registerForActivityResult
    ioReq = null
    ioCopyAndReport(req, "photo", if (u != null) listOf(u) else emptyList(), false)
  }
  private val ioPhotoMany = registerForActivityResult(androidx.activity.result.contract.ActivityResultContracts.PickMultipleVisualMedia(50)) { us ->
    val req = ioReq ?: return@registerForActivityResult
    ioReq = null
    ioCopyAndReport(req, "photo", us, false)
  }
  private val ioCreate = registerForActivityResult(androidx.activity.result.contract.ActivityResultContracts.StartActivityForResult()) { r ->
    val req = ioReq ?: return@registerForActivityResult
    val from = ioSaveFrom
    ioReq = null
    ioSaveFrom = null
    val dest = r.data?.data
    if (r.resultCode != RESULT_OK || dest == null || from == null) {
      ioDone(req, org.json.JSONObject.quote("cancelled"))
      return@registerForActivityResult
    }
    Thread {
      val ok = try {
        java.io.FileInputStream(from).use { i -> contentResolver.openOutputStream(dest, "w")!!.use { o -> i.copyTo(o, 1 shl 20) } }
        true
      } catch (e: Exception) {
        android.util.Log.w("MemoAnima", "[io] save failed ${e.javaClass.simpleName}")
        false
      }
      ioDone(req, org.json.JSONObject.quote(if (ok) "saved" else "failed"))
    }.start()
  }

  private fun ioInDir(): java.io.File = java.io.File(cacheDir, "memoanima-io/in")

  private fun ioDone(req: String, json: String) {
    ioMain.post {
      web?.evaluateJavascript("(function(){try{if(typeof window.__mbIoDone==='function'){window.__mbIoDone(${org.json.JSONObject.quote(req)},$json)}}catch(e){}})()", null)
    }
  }

  /** 共有（Rust から）: 書き出しの一時の場所のファイルを、このアプリの FileProvider の URI で ACTION_SEND に渡す（読む許可を一時的に） */
  // ★R8 が消さないように（JNI からだけ呼ぶ＝コードの中に呼ぶ所が無い。消えると NoSuchMethodError でアプリごと落ちていた）
  @androidx.annotation.Keep
  @Suppress("unused")
  fun ioShare(path: String, mime: String, req: String, unused: Boolean) {
    try {
      val f = java.io.File(path)
      val out = java.io.File(cacheDir, "memoanima-io/out").canonicalFile
      if (!f.canonicalFile.path.startsWith(out.path + java.io.File.separator)) throw SecurityException("outside")
      val uri = androidx.core.content.FileProvider.getUriForFile(this, "$packageName.memoanimaio", f)
      val send = android.content.Intent(android.content.Intent.ACTION_SEND).apply {
        type = mime
        putExtra(android.content.Intent.EXTRA_STREAM, uri)
        clipData = android.content.ClipData.newRawUri(f.name, uri)
        addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }
      startActivity(android.content.Intent.createChooser(send, null))
      ioDone(req, org.json.JSONObject.quote("shared"))
    } catch (e: Exception) {
      android.util.Log.w("MemoAnima", "[io] share failed ${e.javaClass.simpleName}")
      ioDone(req, org.json.JSONObject.quote("failed"))
    }
  }

  /** 保存（Rust から）: ドキュメントを作る画面に名前と種類を渡し、選ばれた場所へストリームで写す */
  @androidx.annotation.Keep
  @Suppress("unused")
  fun ioSave(path: String, mime: String, name: String, req: String, unused: Boolean) {
    ioReq = req
    ioSaveFrom = path
    try {
      ioCreate.launch(android.content.Intent(android.content.Intent.ACTION_CREATE_DOCUMENT).apply {
        addCategory(android.content.Intent.CATEGORY_OPENABLE)
        type = mime
        putExtra(android.content.Intent.EXTRA_TITLE, name)
      })
    } catch (e: Exception) {
      ioReq = null
      ioSaveFrom = null
      ioDone(req, org.json.JSONObject.quote("failed"))
    }
  }

  /** 選ぶ（Rust から）: works・image・audio は ACTION_OPEN_DOCUMENT（複数可）・photo は写真の選択（権限なし） */
  @androidx.annotation.Keep
  @Suppress("unused")
  fun ioPick(kind: String, inDir: String, req: String, multiple: Boolean) {
    ioReq = req
    ioKind = kind
    try {
      if (kind == "photo") {
        val r = androidx.activity.result.PickVisualMediaRequest(androidx.activity.result.contract.ActivityResultContracts.PickVisualMedia.ImageOnly)
        if (multiple) ioPhotoMany.launch(r) else ioPhotoOne.launch(r)
        return
      }
      val mimes = when (kind) {
        "image" -> arrayOf("image/png", "image/jpeg", "image/heic", "image/heif")
        "audio" -> arrayOf("audio/*", "video/*")
        else -> arrayOf("*/*")
      }
      ioDocs.launch(android.content.Intent(android.content.Intent.ACTION_OPEN_DOCUMENT).apply {
        addCategory(android.content.Intent.CATEGORY_OPENABLE)
        type = if (mimes.size == 1) mimes[0] else "*/*"
        if (mimes.size > 1) putExtra(android.content.Intent.EXTRA_MIME_TYPES, mimes)
        putExtra(android.content.Intent.EXTRA_ALLOW_MULTIPLE, multiple)
      })
    } catch (e: Exception) {
      ioReq = null
      ioDone(req, "[]")
    }
  }

  /** 名札（16 桁の 16 進） */
  private fun ioTag(): String = java.util.UUID.randomUUID().toString().replace("-", "").substring(0, 16)

  /** 断る URI（file://・このアプリ自身の FileProvider） */
  private fun ioRefused(u: android.net.Uri): Boolean {
    if (u.scheme != "content") return true
    val a = u.authority ?: return true
    return a == "$packageName.fileprovider" || a == "$packageName.memoanimaio" || a.startsWith("$packageName.")
  }

  /** 1 つを in/<名札>/ へ写す。門番を超えたら止めて消す。HEIC は PNG に */
  private fun ioCopyOne(u: android.net.Uri, kind: String, recv: Boolean): org.json.JSONObject? {
    if (ioRefused(u)) {
      android.util.Log.w("MemoAnima", "[io] refused uri scheme=${u.scheme}")
      return null
    }
    val limit = if (kind == "works") 512L shl 20 else 64L shl 20
    val tag = ioTag()
    val dir = java.io.File(ioInDir(), tag)
    try {
      dir.mkdirs()
      var name = ""
      var declared = -1L
      contentResolver.query(u, arrayOf(android.provider.OpenableColumns.DISPLAY_NAME, android.provider.OpenableColumns.SIZE), null, null, null)?.use { c ->
        if (c.moveToFirst()) {
          if (!c.isNull(0)) name = c.getString(0) ?: ""
          if (!c.isNull(1)) declared = c.getLong(1)
        }
      }
      if (declared > limit) throw java.io.IOException("too-large")
      val tmp = java.io.File(dir, "data.tmp")
      var n = 0L
      contentResolver.openInputStream(u)!!.use { i ->
        java.io.FileOutputStream(tmp).use { o ->
          val buf = ByteArray(1 shl 20)
          while (true) {
            val k = i.read(buf)
            if (k < 0) break
            n += k
            if (n > limit) throw java.io.IOException("too-large")
            o.write(buf, 0, k)
          }
          o.fd.sync()
        }
      }
      val mime = contentResolver.getType(u) ?: ""
      if ((kind == "photo" || kind == "image") && ioIsHeic(tmp, mime)) {
        val png = java.io.File(dir, "data.png.tmp")
        // ★V229（独立レビューの指摘・直す）: 画素の数の門番（4,000 万画素＝PNG にして 160MB 級を超えない）。超えたら読まない
        val bmp = android.graphics.ImageDecoder.decodeBitmap(android.graphics.ImageDecoder.createSource(tmp)) { d, info, _ ->
          if (info.size.width.toLong() * info.size.height.toLong() > 40_000_000L) throw java.io.IOException("too-large")
          d.allocator = android.graphics.ImageDecoder.ALLOCATOR_SOFTWARE
        }
        java.io.FileOutputStream(png).use { o -> bmp.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, o) }
        bmp.recycle()
        tmp.delete()
        png.renameTo(tmp)
        n = tmp.length()
        // 変換したあとの PNG も門番（画像は 64MiB）
        if (n > limit) throw java.io.IOException("too-large")
        name = name.replace(Regex("\\.(heic|heif)$", RegexOption.IGNORE_CASE), "") + ".png"
      }
      if (!tmp.renameTo(java.io.File(dir, "data"))) throw java.io.IOException("rename")
      val meta = org.json.JSONObject().put("tag", tag).put("name", name).put("size", n)
      java.io.File(dir, "meta.json").writeText(meta.toString())
      if (recv) java.io.File(dir, "recv").writeText("")
      return meta
    } catch (e: Exception) {
      // ★V229（独立レビューの指摘・記録）: 例外の文には URI や名前が入りうるので書かない（種類だけ）
      android.util.Log.w("MemoAnima", "[io] copy failed ${e.javaClass.simpleName}")
      dir.deleteRecursively()
      return null
    }
  }

  private fun ioIsHeic(f: java.io.File, mime: String): Boolean {
    if (mime == "image/heic" || mime == "image/heif") return true
    val h = ByteArray(12)
    val k = java.io.FileInputStream(f).use { it.read(h) }
    if (k < 12) return false
    val brand = String(h, 8, 4, Charsets.ISO_8859_1)
    return String(h, 4, 4, Charsets.ISO_8859_1) == "ftyp" && brand in setOf("heic", "heix", "heim", "heis", "hevc", "hevx", "mif1", "msf1")
  }

  /** 写して、画面へ InItem の配列を返す（選ぶ）か、受け取りの知らせを出す（受け取り） */
  private fun ioCopyAndReport(req: String?, kind: String, uris: List<android.net.Uri>, recv: Boolean) {
    Thread {
      val arr = org.json.JSONArray()
      // ★V229（独立レビューの指摘・直す）: 同じ URI を 2 回写さない（SEND_MULTIPLE に同じものが並んでいても 1 回）
      for (u in uris.distinct()) ioCopyOne(u, kind, recv)?.let { arr.put(it) }
      if (req != null) ioDone(req, arr.toString())
      if (recv && arr.length() > 0) {
        ioMain.post { web?.evaluateJavascript("(function(){try{if(typeof window.__mbIoInbox==='function'){window.__mbIoInbox()}}catch(e){}})()", null) }
      }
    }.start()
  }

  /** ★受け取り（VIEW・SEND・SEND_MULTIPLE）。同じ intent を 2 回扱わない（印の extra を付ける＝Activity の作り直しで 2 回にならない） */
  private fun ioHandleIntent(i: android.content.Intent?) {
    if (i == null || i.getBooleanExtra("memoanima.io.handled", false)) return
    val uris = mutableListOf<android.net.Uri>()
    when (i.action) {
      android.content.Intent.ACTION_VIEW -> i.data?.let { uris.add(it) }
      android.content.Intent.ACTION_SEND -> ioStream(i)?.let { uris.add(it) }
      android.content.Intent.ACTION_SEND_MULTIPLE -> uris.addAll(ioStreams(i))
      else -> return
    }
    i.putExtra("memoanima.io.handled", true)
    if (uris.isEmpty()) return
    ioCopyAndReport(null, "works", uris, true)
  }

  @Suppress("DEPRECATION")
  private fun ioStream(i: android.content.Intent): android.net.Uri? =
    if (android.os.Build.VERSION.SDK_INT >= 33) i.getParcelableExtra(android.content.Intent.EXTRA_STREAM, android.net.Uri::class.java)
    else i.getParcelableExtra(android.content.Intent.EXTRA_STREAM)

  @Suppress("DEPRECATION")
  private fun ioStreams(i: android.content.Intent): List<android.net.Uri> =
    (if (android.os.Build.VERSION.SDK_INT >= 33) i.getParcelableArrayListExtra(android.content.Intent.EXTRA_STREAM, android.net.Uri::class.java)
    else i.getParcelableArrayListExtra(android.content.Intent.EXTRA_STREAM)) ?: emptyList()

  override fun onNewIntent(intent: android.content.Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    ioHandleIntent(intent)
  }

  override fun onSaveInstanceState(outState: Bundle) {
    super.onSaveInstanceState(outState)
    outState.putString("memoanima.io.req", ioReq)
    outState.putString("memoanima.io.kind", ioKind)
    outState.putString("memoanima.io.saveFrom", ioSaveFrom)
  }
}

/** ★V229: 書き出しの一時の場所（cacheDir/memoanima-io/out）だけを指す FileProvider（公開しない・res/xml/memoanima_io_paths.xml） */
class MemoAnimaIoProvider : androidx.core.content.FileProvider()
