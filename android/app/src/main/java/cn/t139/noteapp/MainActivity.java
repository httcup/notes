package cn.t139.noteapp;

import android.Manifest;
import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.view.ViewGroup;
import android.view.Window;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

/**
 * 随手记笔记本 · Android 客户端
 *
 * 本质是一个轻量 WebView 外壳：打开 https://n.139t.cn，把网页缺的三件事补上：
 *   1. 选文件（导入笔记）
 *   2. 导出文件（网页里的 blob 下载）→ 存到系统「下载」目录
 *   3. 待办提醒 → 系统通知（WebView 不支持 Web Notification，用 JS 垫片转到原生）
 */
public class MainActivity extends Activity {

    private static final String HOME_URL = "https://n.139t.cn/";
    private static final String MAIN_HOST = "n.139t.cn";
    private static final String ALT_HOST = "139t.cn";
    private static final int REQ_FILE = 1001;
    private static final int REQ_POST_NOTIF = 1002;
    private static final int REQ_WRITE_STORAGE = 1003;
    private static final String CHANNEL_ID = "ivynote";

    private WebView web;
    private ValueCallback<Uri[]> filePathCallback;
    private String pendingSaveName;   // 等写权限时暂存的保存请求

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        if (Build.VERSION.SDK_INT >= 21) {
            Window w = getWindow();
            w.setStatusBarColor(0xFFF5F4EF);
            w.setNavigationBarColor(0xFFF5F4EF);
            if (Build.VERSION.SDK_INT >= 23) {
                w.getDecorView().setSystemUiVisibility(
                        android.view.View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);
            }
        }

        FrameLayout root = new FrameLayout(this);
        web = new WebView(this);
        root.addView(web, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        s.setLoadWithOverviewMode(false);
        s.setUseWideViewPort(true);
        s.setBuiltInZoomControls(false);
        s.setSupportZoom(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setUserAgentString(s.getUserAgentString() + " IvyNoteAndroid/1.0");

        web.addJavascriptInterface(new Bridge(), "Android");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                return openExternally(req.getUrl());
            }

            @SuppressWarnings("deprecation")
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return openExternally(Uri.parse(url));
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                injectNativeShim();
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> cb,
                                             FileChooserParams params) {
                if (filePathCallback != null) filePathCallback.onReceiveValue(null);
                filePathCallback = cb;

                Intent i = new Intent(Intent.ACTION_GET_CONTENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("*/*");
                String[] accept = params.getAcceptTypes();
                if (accept != null && accept.length > 0 && accept[0] != null) {
                    String a = accept[0].toLowerCase();
                    if (a.contains("image")) i.setType("image/*");
                    else if (a.contains("json")) i.setType("application/json");
                    else if (a.contains("html")) i.setType("text/html");
                    else if (a.contains("markdown") || a.contains("text")) i.setType("text/*");
                }
                try {
                    startActivityForResult(Intent.createChooser(i, "选择要导入的文件"), REQ_FILE);
                } catch (Exception e) {
                    filePathCallback = null;
                    toast("打不开文件选择器");
                    return false;
                }
                return true;
            }
        });

        // 网页里指向直链（比如客户端下载 zip）时，交给系统浏览器
        web.setDownloadListener((url, ua, cd, mime, len) -> {
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
                toast("已交给浏览器下载");
            } catch (Exception e) {
                toast("无法打开下载链接");
            }
        });

        web.loadUrl(HOME_URL);
        askNotificationPermission();
    }

    /* ---------- 外链：本站留在 WebView，其它交给系统 ---------- */
    private boolean openExternally(Uri u) {
        String scheme = u.getScheme() == null ? "" : u.getScheme().toLowerCase();
        String host = u.getHost() == null ? "" : u.getHost().toLowerCase();
        if ((scheme.equals("http") || scheme.equals("https"))
                && (host.equals(MAIN_HOST) || host.equals(ALT_HOST))) {
            return false;   // 站内链接继续在 WebView 里
        }
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, u));
        } catch (Exception e) {
            toast("没有能打开这个链接的应用");
        }
        return true;
    }

    /* ---------- 注入原生垫片：通知 + blob 导出 ---------- */
    private void injectNativeShim() {
        String js =
            "(function(){\n" +
            "  if (window.__IVY_ANDROID__) return;\n" +
            "  window.__IVY_ANDROID__ = true;\n" +
            "  window.__IVY_NATIVE_APP = true;\n" +
            // 通知：网页里 new Notification(...) 转到系统通知
            "  function Shim(title, opts){\n" +
            "    opts = opts || {};\n" +
            "    this.title = String(title || '');\n" +
            "    this.body = String(opts.body || '');\n" +
            "    this.tag = opts.tag || '';\n" +
            "    this.close = function(){};\n" +
            "    this.onclick = null;\n" +
            "    try{ Android.notify(this.title, this.body); }catch(e){}\n" +
            "  }\n" +
            "  Shim.permission = 'granted';\n" +
            "  Shim.requestPermission = function(){ return Promise.resolve('granted'); };\n" +
            "  Shim.maxActions = 0;\n" +
            "  try{ window.Notification = Shim; }catch(e){}\n" +
            // 导出：网页用 <a download> + blob，WebView 不会下载，转成原生保存
            "  var origClick = HTMLAnchorElement.prototype.click;\n" +
            "  HTMLAnchorElement.prototype.click = function(){\n" +
            "    var href = this.getAttribute('href') || '';\n" +
            "    var name = this.getAttribute('download') || '';\n" +
            "    if (href.indexOf('blob:') === 0) {\n" +
            "      var self = this;\n" +
            "      fetch(href).then(function(r){ return r.blob(); }).then(function(b){\n" +
            "        var fr = new FileReader();\n" +
            "        fr.onload = function(){\n" +
            "          var s = String(fr.result || '');\n" +
            "          var i = s.indexOf(',');\n" +
            "          try{ Android.saveFile(name || '全部笔记', s.slice(i + 1), b.type || ''); }\n" +
            "          catch(e){ origClick.call(self); }\n" +
            "        };\n" +
            "        fr.readAsDataURL(b);\n" +
            "      }).catch(function(){ origClick.call(self); });\n" +
            "      return;\n" +
            "    }\n" +
            "    return origClick.apply(this, arguments);\n" +
            "  };\n" +
            "})();";
        web.evaluateJavascript(js, null);
    }

    /* ---------- 原生桥 ---------- */
    private class Bridge {
        @JavascriptInterface
        public void notify(String title, String body) {
            showNotification(title, body);
        }

        @JavascriptInterface
        public void saveFile(String name, String base64, String mime) {
            saveToDownloads(name, base64, mime);
        }
    }

    private void saveToDownloads(final String name, final String base64, final String mime) {
        if (Build.VERSION.SDK_INT < 29
                && checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE)
                    != PackageManager.PERMISSION_GRANTED) {
            pendingSaveName = name + "\u0000" + base64 + "\u0000" + mime;
            requestPermissions(new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE},
                    REQ_WRITE_STORAGE);
            return;
        }
        doSave(name, base64, mime);
    }

    private void doSave(String name, String base64, String mime) {
        try {
            byte[] data = Base64.decode(base64, Base64.DEFAULT);
            String safeMime = (mime == null || mime.isEmpty())
                    ? "application/octet-stream" : mime;
            String shownPath;

            if (Build.VERSION.SDK_INT >= 29) {
                ContentValues cv = new ContentValues();
                cv.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
                cv.put(MediaStore.MediaColumns.MIME_TYPE, safeMime);
                cv.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
                Uri uri = getContentResolver()
                        .insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
                if (uri == null) throw new Exception("系统没给创建文件的权限");
                OutputStream os = getContentResolver().openOutputStream(uri);
                if (os == null) throw new Exception("写不进下载目录");
                os.write(data);
                os.close();
                shownPath = "「下载」文件夹 / " + name;
            } else {
                File dir = Environment.getExternalStoragePublicDirectory(
                        Environment.DIRECTORY_DOWNLOADS);
                if (!dir.exists()) dir.mkdirs();
                File f = new File(dir, name);
                FileOutputStream fo = new FileOutputStream(f);
                fo.write(data);
                fo.close();
                shownPath = f.getAbsolutePath();
            }

            final String msg = "已保存：" + shownPath;
            runOnUiThread(() -> Toast.makeText(this, msg, Toast.LENGTH_LONG).show());
        } catch (Exception e) {
            final String msg = "保存失败：" + (e.getMessage() == null ? "未知错误" : e.getMessage());
            runOnUiThread(() -> Toast.makeText(this, msg, Toast.LENGTH_LONG).show());
        }
    }

    private void showNotification(String title, String body) {
        try {
            NotificationManager nm =
                    (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (nm == null) return;
            if (Build.VERSION.SDK_INT >= 26) {
                NotificationChannel ch = new NotificationChannel(
                        CHANNEL_ID, "待办提醒", NotificationManager.IMPORTANCE_DEFAULT);
                ch.setDescription("笔记里的待办到点提醒");
                nm.createNotificationChannel(ch);
            }
            Intent it = new Intent(this, MainActivity.class);
            it.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            int flags = PendingIntent.FLAG_UPDATE_CURRENT;
            if (Build.VERSION.SDK_INT >= 23) flags |= PendingIntent.FLAG_IMMUTABLE;
            PendingIntent pi = PendingIntent.getActivity(this, 0, it, flags);

            Notification.Builder b = Build.VERSION.SDK_INT >= 26
                    ? new Notification.Builder(this, CHANNEL_ID)
                    : new Notification.Builder(this);
            b.setSmallIcon(android.R.drawable.ic_popup_reminder)
             .setContentTitle(title == null || title.isEmpty() ? "随手记笔记本" : title)
             .setContentText(body == null ? "" : body)
             .setStyle(new Notification.BigTextStyle().bigText(body == null ? "" : body))
             .setAutoCancel(true)
             .setContentIntent(pi);
            nm.notify((int) (System.currentTimeMillis() & 0x7fffffff), b.build());
        } catch (Exception ignored) {
        }
    }

    private void askNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                    != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS},
                    REQ_POST_NOTIF);
        }
    }

    /* ---------- 结果回调 ---------- */
    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_FILE) {
            if (filePathCallback == null) return;
            Uri[] result = null;
            if (resultCode == RESULT_OK && data != null && data.getData() != null) {
                result = new Uri[]{data.getData()};
            }
            filePathCallback.onReceiveValue(result);
            filePathCallback = null;
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] perms, int[] granted) {
        super.onRequestPermissionsResult(requestCode, perms, granted);
        if (requestCode == REQ_WRITE_STORAGE && pendingSaveName != null) {
            String[] parts = pendingSaveName.split("\u0000", -1);
            pendingSaveName = null;
            if (granted.length > 0 && granted[0] == PackageManager.PERMISSION_GRANTED) {
                doSave(parts[0], parts[1], parts[2]);
            } else {
                toast("没有存储权限，导出的文件存不下来");
            }
        }
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) {
            web.goBack();
        } else {
            super.onBackPressed();
        }
    }

    private void toast(String msg) {
        runOnUiThread(() -> Toast.makeText(this, msg, Toast.LENGTH_SHORT).show());
    }
}
