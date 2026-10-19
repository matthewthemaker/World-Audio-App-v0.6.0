package app.worldaudio;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;

/**
 * World Audio for Android.
 *
 * Two WebViews share the screen:
 *  - "player" shows YouTube / YouTube Music. assets/engine.js is injected into every YouTube page and
 *    routes the page's own audio through the World Audio engine (Web Audio, HRTF, room reverb).
 *  - "controls" shows the local control panel (assets/ui). It talks to the engine through the
 *    small Bridge below. The bridge is only attached to the local panel, never to the web player.
 */
public class MainActivity extends Activity {

    private static final String HOME_YOUTUBE = "https://m.youtube.com/";
    private static final String HOME_MUSIC = "https://music.youtube.com/";
    private static final String CONTROLS_URL = "file:///android_asset/ui/index.html";

    // Pages the player may show. Everything else opens in the phone's normal browser.
    private static final String[] ALLOWED_HOST_SUFFIXES = {
            "youtube.com", "google.com", "gstatic.com", "ytimg.com",
            "googlevideo.com", "googleusercontent.com", "ggpht.com"
    };

    private WebView player;
    private WebView controls;
    private Button btnYoutube;
    private Button btnMusic;
    private String engineJs = "";
    private int layoutMode = 0; // 0 = split, 1 = big video, 2 = big controls

    private View customView;
    private WebChromeClient.CustomViewCallback customViewCallback;

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        try {
            engineJs = readAsset("engine.js");
        } catch (IOException e) {
            engineJs = "";
        }

        player = findViewById(R.id.player);
        controls = findViewById(R.id.controls);
        btnYoutube = findViewById(R.id.btnYoutube);
        btnMusic = findViewById(R.id.btnMusic);

        setupPlayer();
        setupControls();

        btnYoutube.setOnClickListener(v -> player.loadUrl(HOME_YOUTUBE));
        btnMusic.setOnClickListener(v -> player.loadUrl(HOME_MUSIC));
        findViewById(R.id.btnLayout).setOnClickListener(v -> {
            layoutMode = (layoutMode + 1) % 3;
            applyLayout();
        });
        applyLayout();
        highlight(HOME_YOUTUBE);

        player.loadUrl(HOME_YOUTUBE);
        controls.loadUrl(CONTROLS_URL);
    }

    // ---------- player (YouTube) ----------

    @SuppressLint("SetJavaScriptEnabled")
    private void setupPlayer() {
        WebSettings s = player.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        // Lets the audio engine start without a tap inside the page.
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setSupportMultipleWindows(false);
        player.setBackgroundColor(Color.BLACK);

        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(player, true);

        player.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return handleNavigation(request.getUrl());
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                highlight(url);
                injectEngine(view, url);
            }
        });

        player.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onShowCustomView(View view, CustomViewCallback callback) {
                if (customView != null) {
                    callback.onCustomViewHidden();
                    return;
                }
                customView = view;
                customViewCallback = callback;
                ((FrameLayout) getWindow().getDecorView()).addView(view,
                        new FrameLayout.LayoutParams(
                                FrameLayout.LayoutParams.MATCH_PARENT,
                                FrameLayout.LayoutParams.MATCH_PARENT));
                setImmersive(true);
            }

            @Override
            public void onHideCustomView() {
                exitFullscreen();
            }
        });
    }

    private boolean handleNavigation(Uri uri) {
        String scheme = uri.getScheme();
        if (!"http".equals(scheme) && !"https".equals(scheme)) {
            return true; // swallow app-link / intent:// jumps so we stay in the player
        }
        if (isAllowedHost(uri.getHost())) {
            return false;
        }
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (Exception ignored) {
            // no browser available
        }
        return true;
    }

    private static boolean isAllowedHost(String host) {
        if (host == null) return false;
        for (String suffix : ALLOWED_HOST_SUFFIXES) {
            if (host.equals(suffix) || host.endsWith("." + suffix)) return true;
        }
        return false;
    }

    private void injectEngine(WebView view, String url) {
        if (engineJs.isEmpty() || url == null) return;
        String host = Uri.parse(url).getHost();
        if (host == null) return;
        boolean youtube = host.equals("youtube.com") || host.endsWith(".youtube.com");
        if (!youtube || host.startsWith("consent.")) return;
        view.evaluateJavascript(engineJs, null);
    }

    private void highlight(String url) {
        boolean music = url != null && url.contains("music.youtube.com");
        int on = getResources().getColor(R.color.accent, getTheme());
        btnMusic.setBackgroundColor(music ? on : Color.TRANSPARENT);
        btnYoutube.setBackgroundColor(music ? Color.TRANSPARENT : on);
    }

    // ---------- control panel ----------

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    private void setupControls() {
        WebSettings s = controls.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        controls.setBackgroundColor(getResources().getColor(R.color.bg, getTheme()));
        controls.setOverScrollMode(View.OVER_SCROLL_NEVER);
        controls.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return true; // the panel never navigates anywhere else
            }
        });
        controls.addJavascriptInterface(new Bridge(), "Android");
    }

    private class Bridge {
        /** Runs one engine command inside the YouTube page and sends the JSON reply back to the panel. */
        @JavascriptInterface
        public void call(final int id, final String json) {
            runOnUiThread(() -> {
                String script = "(function(){try{"
                        + "if(!window.__WA)return JSON.stringify({ok:false,error:'not-ready'});"
                        + "return JSON.stringify(window.__WA.handle(" + json + "));"
                        + "}catch(e){return JSON.stringify({ok:false,error:String(e&&e.message||e)});}})()";
                player.evaluateJavascript(script, value ->
                        controls.evaluateJavascript(
                                "window.__resolve(" + id + "," + (value == null ? "null" : value) + ")", null));
            });
        }

        @JavascriptInterface
        public void keepAwake(final boolean on) {
            runOnUiThread(() -> {
                if (on) {
                    getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                } else {
                    getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                }
            });
        }
    }

    // ---------- layout, fullscreen, back button ----------

    private void applyLayout() {
        float[] playerWeight = {1f, 3f, 1f};
        float[] controlsWeight = {1f, 1f, 3f};
        setWeight(player, playerWeight[layoutMode]);
        setWeight(controls, controlsWeight[layoutMode]);
    }

    private static void setWeight(View v, float weight) {
        LinearLayout.LayoutParams lp = (LinearLayout.LayoutParams) v.getLayoutParams();
        lp.weight = weight;
        v.setLayoutParams(lp);
    }

    private void exitFullscreen() {
        if (customView == null) return;
        ((FrameLayout) getWindow().getDecorView()).removeView(customView);
        customView = null;
        if (customViewCallback != null) customViewCallback.onCustomViewHidden();
        customViewCallback = null;
        setImmersive(false);
    }

    @SuppressWarnings("deprecation")
    private void setImmersive(boolean on) {
        int flags = on
                ? View.SYSTEM_UI_FLAG_FULLSCREEN
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                : View.SYSTEM_UI_FLAG_VISIBLE;
        getWindow().getDecorView().setSystemUiVisibility(flags);
    }

    @SuppressWarnings("deprecation")
    @Override
    public void onBackPressed() {
        if (customView != null) {
            exitFullscreen();
        } else if (player.canGoBack()) {
            player.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        controls.removeJavascriptInterface("Android");
        controls.destroy();
        player.destroy();
        super.onDestroy();
    }

    private String readAsset(String name) throws IOException {
        try (InputStream in = getAssets().open(name);
             ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
            }
            return out.toString("UTF-8");
        }
    }
}
