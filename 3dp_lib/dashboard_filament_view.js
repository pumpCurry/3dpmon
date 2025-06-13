/* -----------------------------------------------------------------------
   dashboard_filament_view.js  (2025-06)
   Stand-Alone Filament Reel Preview
   © pumpCurry – MIT License
   -----------------------------------------------------------------------
   ------
   使い方
   ------
     <!-- HTML 側 -->
     <div id="filament-preview"></div>

     <!-- 読み込み -->
     <script src="dashboard_filament_view.js"></script>
     <script>
       const preview = createFilamentPreview(
         document.getElementById('filament-preview'),
         {
           // ▼ 必須
           filamentDiameter:           1.75,   // mm
           filamentTotalLength:        330000, // mm
           filamentCurrentLength:      120000, // mm (残量)
           filamentColor:              '#22C55E',

           reelOuterDiameter:          200,    // mm
           reelThickness:              68,     // mm
           reelWindingInnerDiameter:    95,    // mm
           reelCenterHoleDiameter:      54,    // mm

           // ▼ 任意
           reelBodyColor:              '#A1A1AA',
           reelFlangeTransparency:     0.4,
           reelWindingForegroundColor: '#71717A',
           reelCenterHoleForegroundColor:'#F4F4F5',

           isFilamentPresent:          true,
           showUsedUpIndicator:        true,
           blinkingLightColor:         '#0EA5E9',

           widthPx:                    300,
           heightPx:                   300,
           initialRotX:               -25,
           initialRotY:                35,
           initialRotZ:               -50,

           showInfoLength:             true,
           showInfoPercent:            true,
           showInfoLayers:             true,

           showResetButton:            true,
           showProfileViewButton:      true,
           showFrontViewButton:        true,
           showSideViewButton:         true,
           showAutoRotateButton:       true,

           disableInteraction:         false

           showOverlayLength:          false,
           showOverlayPercent:         false,
           enableDrag:                 true,
           enableClick:                false,
           onClick:                    null,
           showLengthKg:               false,
           reelName:                   '',
           reelSubName:                '',

           materialName:               '',
           materialColorName:          '',
           materialColorCode:          '',
           showReelName:               false,
           showReelSubName:            false,
           showMaterialName:           false,
           showMaterialColorName:      false,
           showMaterialColorCode:      false,
           manufacturerName:           '',
           showManufacturerName:       false,
         }
       );

       // 動的更新例
       // preview.setRemainingLength(80000);
       // preview.setState({ isFilamentPresent:false });
       
     </script>
   ---------------------------------------------------------------------*/

/* --------------------------------------------------------------------- */
/*  0.  CSS インジェクション（重複挿入防止）                            */
/* --------------------------------------------------------------------- */
(function injectCSS() {
  const ID = 'dfv-style';
  if (document.getElementById(ID)) return;
  const css = `
  .dfv-root { position: relative; user-select: none; font-family: sans-serif; }
  .dfv-scene { position:absolute; top:50%; left:50%; transform-style:preserve-3d; }
  .dfv-card  { border:1px solid #ccc; border-radius:8px; padding:8px; display:inline-block; }
  .dfv-slider { width:100%; margin-top:4px; }
  .dfv-btn    { margin-left:4px; cursor:pointer; }
  .dfv-btn-active { background:#e5e7eb; }
  .dfv-blink-light { animation: dfv-blink-light 1.5s infinite ease-in-out; }
  @keyframes dfv-blink-light { 0%,100%{opacity:1;transform:scale(1);}50%{opacity:.3;transform:scale(.8);} }
  .dfv-blink-slash { animation: dfv-blink-slash 0.5s infinite alternate ease-in-out; }
  @keyframes dfv-blink-slash { from{opacity:1;} to{opacity:.3;} }

  /* オーバーレイ */
  .dfv-overlay { position:absolute; top:6px; left:6px; bottom:6px; right:6px; pointer-events:none; z-index:12; }
  .dfv-overlay-length        { font-size:0.8em; font-weight:bold; color:#000; margin:2px 0; }
  .dfv-overlay-percent       { font-size:2.8em; font-weight:bold; color:#000; position:absolute; bottom:10px; right:10px; font-family: monospace;}

  .dfv-overlay-name          { font-size:1.5em; font-weight:bold; color:#000; margin:2px 0; }
  .dfv-overlay-subname       { font-size:1.0em; font-weight:bold; color:#000; margin:2px 0; }
  .dfv-overlay-material      { font-size:1.2em;                   color:#000; margin:2px 0; }
  .dfv-overlay-colorcode     { font-size:1.0em;                   color:#000; margin:2px 0; }
  .dfv-overlay-manufacturer  { font-size:1.2em; font-weight:bold; color:#000; margin:2px 0; }
  
  /* ％表示：各パーツを分けてスタイル可能に */
  .dfv-overlay-percent { margin:2px; }
  .dfv-overlay-percent-int   { font-size:1.5em; font-weight:bold; }
  .dfv-overlay-percent-dot   { font-size:0.6em; font-weight:bold; }
  .dfv-overlay-percent-frac  { font-size:1.2em; }
  .dfv-overlay-percent-sign  { font-size:1.0em; }

  /* マテリアルタグ */
  .dfv-material-tag {
    position:absolute; top:10px; right:10px;
    padding:4px 8px; border-radius:4px;
    font-size:0.85em; font-weight:bold;
    pointer-events:none; z-index:14;
  }
`;
  const style = document.createElement('style');
  style.id = ID;
  style.textContent = css;
  document.head.appendChild(style);
})();

/* --------------------------------------------------------------------- */
/*  1.  型定義 (JSDoc)                                                   */
/* --------------------------------------------------------------------- */
/**
 * @typedef {Object} FilamentOptions
 * @property {number} filamentDiameter               フィラメント径 [mm]
 * @property {number} filamentTotalLength            総フィラメント長さ [mm]
 * @property {number} filamentCurrentLength          現在のフィラメント長さ [mm]
 * @property {string} filamentColor                  フィラメント色（CSSカラー）
 *
 * @property {number} reelOuterDiameter              リール外径 [mm]
 * @property {number} reelThickness                  リール厚み [mm]
 * @property {number} reelWindingInnerDiameter       巻き内径 [mm]
 * @property {number} reelCenterHoleDiameter         中心穴径 [mm]
 *
 * @property {string} [reelBodyColor]                リール本体色（CSSカラー）
 * @property {number} [reelFlangeTransparency]       フランジ透過度 0–1
 * @property {string} [reelWindingForegroundColor]   巻き面色（CSSカラー）
 * @property {string} [reelCenterHoleForegroundColor]中心穴色（CSSカラー）
 *
 * @property {boolean} [isFilamentPresent]           フィラメント有無
 * @property {boolean} [showUsedUpIndicator]         完了インジケータ表示
 * @property {string}  [blinkingLightColor]          ライト色（CSSカラー）
 *
 * @property {number} [widthPx]                      描画幅 [px]（フォントスケール基準）
 * @property {number} [heightPx]                     描画高 [px]
 * @property {number} [initialRotX]                  初期X回転角度 [deg]
 * @property {number} [initialRotY]                  初期Y回転角度 [deg]
 * @property {number} [initialRotZ]                  初期Z回転角度 [deg]
 *
 * @property {boolean} [disableInteraction]          スライダー/ドラッグ操作禁止
 *
 * @property {boolean} [showResetButton]             リセット↺ボタン表示
 * @property {boolean} [showProfileViewButton]       斜め上❍ボタン表示
 * @property {boolean} [showSideViewButton]          真横⦿ボタン表示
 * @property {boolean} [showFrontViewButton]         正面⧦ボタン表示
 * @property {boolean} [showAutoRotateButton]        自動回転⟲ボタン表示
 *
 * @property {boolean} [showOverlayLength]           図上オーバーレイに残長表示
 * @property {boolean} [showOverlayPercent]          図上オーバーレイに残％表示
 * @property {boolean} [showOverlayWeight]           図上オーバーレイに重量表示
 * @property {boolean} [showOverlayLengthOnly]       図上オーバーレイに長さのみ表示
 *
 * @property {number}  [filamentWeightKg]            スプール全体重量 [kg]
 *
 * @property {boolean} [showMaterialTag]             右肩素材タグ表示
 * @property {string}  [materialName]                素材名タグテキスト
 * @property {string}  [materialColorCode]           素材タグ背景色（CSSカラー）
 * @property {string}  [materialTagTextColor]        素材タグ文字色（CSSカラー）
 * @property {string}  [manufacturerName]            フィラメントメーカー名テキスト
 * @property {boolean} [showManufacturerName]        フィラメントメーカー名表示
 *
 * @property {boolean} [showInfoLength]              情報欄に残長表示
 * @property {boolean} [showInfoPercent]             情報欄に残％表示
 * @property {boolean} [showInfoLayers]              情報欄に残レイヤー数表示
 * @property {boolean} [showRotationInfo]            情報欄に回転角度表示
 */

/* --------------------------------------------------------------------- */
/*  2.  ユーティリティ                                                   */
/* --------------------------------------------------------------------- */
/**
 * 16進カラーを rgba 文字列に変換
 * @param {string} hex  "#RRGGBB"
 * @param {number} alpha 0–1
 * @returns {string}
 */
function hexToRgba(hex, alpha = 1) {
  const r = parseInt(hex.slice(1, 3), 16) || 200;
  const g = parseInt(hex.slice(3, 5), 16) || 200;
  const b = parseInt(hex.slice(5, 7), 16) || 200;
  return `rgba(${r},${g},${b},${alpha})`;
}

/**
 * 16進カラー文字列を RGB の数値配列に変換します。
 * @param {string} hex - "#RRGGBB" または "#RGB" 形式のカラーコード
 * @returns {[number,number,number] | null} [r, g, b] の配列、パースに失敗したら null
 */
function parseHexColor(hex) {
  if (typeof hex !== 'string' || hex[0] !== '#' || (hex.length !== 7 && hex.length !== 4)) {
    return null;
  }
  let rStr, gStr, bStr;
  if (hex.length === 4) {
    // "#RGB" 形式
    rStr = hex[1] + hex[1];
    gStr = hex[2] + hex[2];
    bStr = hex[3] + hex[3];
  } else {
    // "#RRGGBB" 形式
    rStr = hex.slice(1, 3);
    gStr = hex.slice(3, 5);
    bStr = hex.slice(5, 7);
  }
  const r = parseInt(rStr, 16);
  const g = parseInt(gStr, 16);
  const b = parseInt(bStr, 16);
  if ([r, g, b].some(c => Number.isNaN(c))) {
    return null;
  }
  return [r, g, b];
}

/**
 * RGB の数値を 16進カラー文字列にフォーマットします。
 * @param {number} r - 赤成分 (0–255)
 * @param {number} g - 緑成分 (0–255)
 * @param {number} b - 青成分 (0–255)
 * @returns {string} "#RRGGBB" 形式のカラーコード
 */
function formatHexColor(r, g, b) {
  const toHex = c => {
    const v = Math.round(Math.max(0, Math.min(255, c)));
    const s = v.toString(16);
    return s.length === 1 ? '0' + s : s;
  };
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/**
 * 2次方程式 ax²+bx+c=0 の正の解を返す（存在しなければ NaN）
 * @param {number} a
 * @param {number} b
 * @param {number} c
 */
function solveQuadraticPositive(a, b, c) {
  if (Math.abs(a) < 1e-9) return Math.abs(b) > 1e-9 ? -c / b : NaN;
  let D = b * b - 4 * a * c;
  if (D < -1e-9) return NaN;
  if (D < 0) D = 0;
  const s = Math.sqrt(D);
  const r1 = (-b + s) / (2 * a);
  const r2 = (-b - s) / (2 * a);
  if (r1 >= -1e-9) return Math.max(0, r1);
  if (r2 >= -1e-9) return Math.max(0, r2);
  return NaN;
}

/* --------------------------------------------------------------------- */
/*  3.  コア計算 (メインファクトリ)                                      */
/* --------------------------------------------------------------------- */
/**
 * フィラメント長 L から各種直径を算出
 * @param {number} L   巻かれている長さ[mm]
 * @param {number} d   フィラメント径[mm]
 * @param {number} r0  1層目中心半径[mm]
 * @param {number} h   層ピッチ[mm]
 * @param {number} A   円周長定数
 * @param {number} windingInnerDia
 */
function calcMetrics(L, d, r0, h, A, windingInnerDia) {
  if (L <= 1e-6) {
    return { Nf: 0, Nfull: 0, f: 0, Dfloor: windingInnerDia, Dnext: windingInnerDia };
  }
  const a = h / 2;
  const b = r0 - h / 2;
  const c = -L / A;
  let Nf = solveQuadraticPositive(a, b, c);
  if (isNaN(Nf) || Nf < 0) Nf = 0;
  const Nfull = Math.floor(Nf);
  const f = Nf - Nfull;
  const Dfloor = windingInnerDia + 2 * Nfull * h;
  const Dnext  = windingInnerDia + 2 * (Nfull + 1) * h;
  return { Nf, Nfull, f, Dfloor, Dnext };
}

/* --------------------------------------------------------------------- */
/*  4.  DOM ビルダ                                                       */
/* --------------------------------------------------------------------- */
/**
 * 共通の div を生成
 * @param {string} cls  className
 * @returns {HTMLDivElement}
 */
function div(cls) {
  const e = document.createElement('div');
  if (cls) e.className = cls;
  return e;
}

/* --------------------------------------------------------------------- */
/*  5.  メインファクトリ                                                 */
/* --------------------------------------------------------------------- */
/**
 * フィラメントプレビューを生成
 * @param {HTMLElement} mount 親要素
 * @param {FilamentOptions} opts 初期オプション
 * @returns {{
 *   setRemainingLength:(n:number)=>void,
 *   setState:(s:Partial<FilamentOptions>)=>void,
 *   resetRotation:()=>void
 * }} */
function createFilamentPreview(mount, opts) {
  /* --- デフォルト値適用 -------------------------------------------- */
  const o = Object.assign({
    reelBodyColor: '#D1D5DB',
    reelFlangeTransparency: 0.3,
    reelWindingForegroundColor: '#A1A1AA',
    reelCenterHoleForegroundColor: '#E5E7EB',
    isFilamentPresent: true,
    showUsedUpIndicator: false,
    blinkingLightColor: '#3B82F6',
    widthPx: 300,
    heightPx: 300,
    initialRotX: -25,
    initialRotY: 35,
    initialRotZ: -50,
    disableInteraction: false,
    showResetButton: true,
    showProfileViewButton: true,
    showSideViewButton: true,
    showFrontViewButton: true,
    showAutoRotateButton: true,
    showOverlayLength: false,
    showOverlayPercent: false,
    enableDrag: true,
    enableClick: false,
    onClick: null,
    showLengthKg: false,
    filamentWeightKg: 0,
    reelName: '',
    materialName: '',
    materialColorName: '',
    materialColorCode: '',
    showReelName: false,
    showMaterialName: false,
    showMaterialColorName: false,
    showMaterialColorCode: false,
    manufacturerName: '',
    showManufacturerName: false,

  }, opts);

  /* --- ルート要素 -------------------------------------------------- */
  mount.classList.add('dfv-card');
  const root = div('dfv-root');
  root.style.width  = o.widthPx  + 'px';
  root.style.height = o.heightPx + 'px';
  const scale = o.widthPx / 300;
  root.style.fontSize = (16 * scale) + 'px';
  root.style.perspective = (Math.max(o.widthPx, o.heightPx) * 2) + 'px';
  root.classList.add('root');
  mount.appendChild(root);

  /* --- 内部状態 ---------------------------------------------------- */
  let rotX = o.initialRotX;
  let rotY = o.initialRotY;
  let rotZ = o.initialRotZ;
  let currentLen = o.filamentCurrentLength;
  let isPresent  = o.isFilamentPresent;
  let autoRotate   = false;
  let autoRotateId = null;

  /* --- 数式用定数 -------------------------------------------------- */
  const d  = o.filamentDiameter;
  const r0 = o.reelWindingInnerDiameter / 2 + d / 2;
  const h  = d * Math.sin(Math.PI / 3);
  const T  = Math.max(1, o.reelThickness / d);
  const A  = T * 2 * Math.PI;

  /* --- スケール計算 ------------------------------------------------ */
  const reelOuterPx = o.widthPx * 0.85;
  const geoScale = reelOuterPx / o.reelOuterDiameter;
  const thicknessPx = o.reelThickness * geoScale;
  const innerPx     = o.reelWindingInnerDiameter * geoScale;
  const holePx      = o.reelCenterHoleDiameter * geoScale;

  /* --- Zオフセット -------------------------------------------------- */
  const zHalf = thicknessPx / 2;
  const zUnit = thicknessPx * 0.005;

  /* --- シーンラッパー -------------------------------------------- */
  const scene = div('dfv-scene');
  scene.style.transform =
    `rotateX(${rotX}deg) rotateY(${rotY}deg)`;
  scene.classList.add('scene');
  root.appendChild(scene);

  // --- オーバーレイ表示要素 ---
  const overlay             = div('dfv-overlay');
  const overlayLength       = div('dfv-overlay-length');
  const overlayPercent      = div('dfv-overlay-percent');
  const overlayName         = div('dfv-overlay-name');
  const overlaySubName      = div('dfv-overlay-subname');
  const overlayMaterial     = div('dfv-overlay-material');
  const overlayColorCode    = div('dfv-overlay-colorcode');
  const overlayManufacturer = div('dfv-overlay-manufacturer');

  overlay.appendChild(overlayLength);
  overlay.appendChild(overlayManufacturer);
  overlay.appendChild(overlayName);
  overlay.appendChild(overlaySubName);
  overlay.appendChild(overlayMaterial);
  overlay.appendChild(overlayColorCode);
  overlay.appendChild(overlayPercent);
  root.appendChild(overlay);

  // マテリアルタグ
  const materialTag=document.createElement('div'); materialTag.className='dfv-material-tag';
  root.appendChild(materialTag);

  /* ヘルパ : 円divの style を作成 */
  const styleCircle = (diaPx, color, extra = '') =>
    `width:${diaPx}px;height:${diaPx}px;border-radius:50%;background:${color};position:absolute;top:50%;left:50%;transform:translate(-50%,-50%) ${extra};`;

  /* ヘルパ : リング div を生成 */
  const ring = (diaPx, borderColor, z) => {
    const e = div();
    e.style.cssText =
      `pointer-events:none;border:1px solid ${borderColor};` +
      styleCircle(diaPx, 'transparent', `translateZ(${z}px)`);
    return e;
  };

  /* --- 背面フランジ ---------------------------------------------- */
  const flangeBack = div();
  flangeBack.style.cssText =
    styleCircle(
      reelOuterPx,
      hexToRgba(o.reelBodyColor, o.reelFlangeTransparency),
      `translateZ(${-zHalf}px)`
    );
  flangeBack.classList.add('flangeBack');
  scene.appendChild(flangeBack);

  /* --- 背面ハブ面 ------------------------------------------------- */
  const hubBack = div();
  hubBack.classList.add('hubBack');
  scene.appendChild(hubBack);

  /* --- 背面センターホール ---------------------------------------- */
  const holeBack = div();
  holeBack.classList.add('holeBack');
  scene.appendChild(holeBack);

  /* --- 背面ゲージ 100% ------------------------------------------- */
  const gauge100Back = ring(0, 'transparent', -(zHalf - zUnit * 3)); // 直径は後で設定
  gauge100Back.classList.add('gauge100Back');
  scene.appendChild(gauge100Back);

  /* --- 背面フィラメントリング(実体+部分)------------------------- */
  const filSolidBack  = div();
  const filPartBack   = div();
  filSolidBack.classList.add('filSolidBack');
  filPartBack.classList.add('filPartBack');
  scene.appendChild(filSolidBack);
  scene.appendChild(filPartBack);

  /* --- 背面その他ゲージ ----------------------------------------- */
  const otherGBack = [0.75, 0.50, 0.25, 0.10].map((p, i) => {
    const g = ring(0, 'transparent',
      -(zHalf - zUnit * (1 - i))); // Z 更新は後で
    g.classList.add('otherGBack');
    scene.appendChild(g);
    return g;
  });

  /* --- シリンダー（ハブ/固体/部分） ------------------------------ */
  const hubCyl = div();
  hubCyl.style.cssText = `position:absolute;top:50%;left:50%;
    width:${innerPx}px;height:${thicknessPx}px;transform:translate(-50%,-50%) rotateX(90deg);
    background:${o.reelBodyColor};border-radius:2px;`;
  hubCyl.classList.add('hubCyl');
  scene.appendChild(hubCyl);

  const hubCylHole = div();

  hubCylHole.style.cssText =
    `position:absolute;
     top:50%; left:50%;
     width:${holePx}px; height:${thicknessPx}px;
     background:${o.reelCenterHoleForegroundColor};
     border-radius:1px;
     transform:translate(-50%,-50%) translateZ(0.1px);`;
/*
  hubCylHole.style.cssText =
    `width:${holePx}px;height:${thicknessPx}px;background:${o.reelCenterHoleForegroundColor};
     transform:translateZ(0.1px);border-radius:1px;position:absolute;top:0;left:50%;
     transform-origin:left center;`;
*/
  hubCylHole.classList.add('hubCylHole');
  hubCyl.appendChild(hubCylHole);

  const filSolidCyl = div();
  const filPartCyl  = div();
  filSolidCyl.classList.add('filSolidCyl');
  filPartCyl.classList.add('filPartCyl');
  scene.appendChild(filSolidCyl);
  scene.appendChild(filPartCyl);

  /* --- インジケータ ---------------------------------------------- */
  const slash   = div();
  const light   = div();
  slash.classList.add('slash');
  light.classList.add('light');
  root.appendChild(slash);
  root.appendChild(light);

  /* --- 前面要素(順序同じ)----------------------------------------- */
  const gauge100Front = ring(0, 'transparent', zHalf - zUnit * 3);
  const filSolidFront = div();
  const filPartFront  = div();
  const otherGFront   = [0.75, 0.50, 0.25, 0.10].map((p, i) => {
    const g = ring(0, 'transparent', zHalf - zUnit * (1 - i));
    g.classList.add('g');
    scene.appendChild(g);
    return g;
  });
  const hubFront  = div();
  const holeFront = div();
  const flangeFront = div();

  gauge100Front.classList.add('gauge100Front');
  filSolidFront.classList.add('filSolidFront');
  filPartFront.classList.add('filPartFront');
  hubFront.classList.add('hubFront');
  holeFront.classList.add('holeFront');
  flangeFront.classList.add('flangeFront');
  scene.appendChild(gauge100Front);
  scene.appendChild(filSolidFront);
  scene.appendChild(filPartFront);
  scene.appendChild(hubFront);
  scene.appendChild(holeFront);
  scene.appendChild(flangeFront);

  /* --- UI (slider & reset) --------------------------------------- */
  const slider = document.createElement('input');
  slider.type  = 'range';
  slider.min   = '0';
  slider.max   = String(o.filamentTotalLength);
  slider.value = String(currentLen);
  slider.className = 'dfv-slider';

  if (o.disableInteraction) {
    slider.disabled = true;
    slider.classList.add('dfv-slider-disabled');
  }

  mount.appendChild(slider);

  // ───────────── ビュー初期化ボタン ─────────────
  let btnReset;
  if (o.showResetButton) {
    btnReset = document.createElement('button');
    btnReset.textContent = '↩︎';
    btnReset.className = 'dfv-btn';
    mount.appendChild(btnReset);

    btnReset.addEventListener('click', () => {
      // 自動回転を解除
      if (autoRotate) {
        cancelAnimationFrame(autoRotateId);
        autoRotate = false;
        btnAuto.classList.remove('dfv-btn-active');
      }
      rotX = o.initialRotX;
      rotY = o.initialRotY;
      rotZ = o.initialRotZ;
      redraw();
    });
  }

  // ───────────── ビュープリセットボタン ─────────────
  let btnProfile;
  if (o.showProfileViewButton) {
    btnProfile = document.createElement('button');
    btnProfile.textContent = '❍';
    btnProfile.className = 'dfv-btn';
    btnProfile.title = '斜め上からのビュー';
    btnProfile.addEventListener('click', () => {

      // 自動回転を解除
      if (autoRotate) {
        cancelAnimationFrame(autoRotateId);
        autoRotate = false;
        btnAuto.classList.remove('dfv-btn-active');
      }

      rotX = -25;
      rotY =  35;
      rotZ = -50;
      redraw();
    });
    mount.appendChild(btnProfile);
  }
  let btnSide;
  if (o.showSideViewButton) {
    btnSide = document.createElement('button');
    btnSide.textContent = '⦿';
    btnSide.className = 'dfv-btn';
    btnSide.title = '正面からのビュー';
    btnSide.addEventListener('click', () => {

      // 自動回転を解除
      if (autoRotate) {
        cancelAnimationFrame(autoRotateId);
        autoRotate = false;
        btnAuto.classList.remove('dfv-btn-active');
      }

      rotX =   0;
      rotY =   0;
      rotZ = -50;
      redraw();
    });
    mount.appendChild(btnSide);
  }

  let btnFront;
  if (o.showFrontViewButton) {
    btnFront = document.createElement('button');
    btnFront.textContent = '⧦';
    btnFront.className = 'dfv-btn';
    btnFront.title = '真横からのビュー';
    btnFront.addEventListener('click', () => {

      // 自動回転を解除
      if (autoRotate) {
        cancelAnimationFrame(autoRotateId);
        autoRotate = false;
        btnAuto.classList.remove('dfv-btn-active');
      }

      rotX = -42;
      rotY =  90;
      rotZ = -50;
      redraw();
    });
    mount.appendChild(btnFront);
  }

  // --- Y軸自動回転トグルボタン --- 
  let btnAuto;
  if (o.showAutoRotateButton) {
    btnAuto = document.createElement('button');
    btnAuto.textContent = '⟲';
    btnAuto.className = 'dfv-btn';
    btnAuto.title = 'Toggle auto-rotate';
    mount.appendChild(btnAuto);
    btnAuto.addEventListener('click', () => {
      if (autoRotate) {
        cancelAnimationFrame(autoRotateId);
        autoRotate = false;
        btnAuto.classList.remove('dfv-btn-active');
      } else {
        autoRotate = true;
        btnAuto.classList.add('dfv-btn-active');
        (function rotateLoop() {
          if (!autoRotate) return;
          rotY += 0.5;
          redraw();
          autoRotateId = requestAnimationFrame(rotateLoop);
        })();
      }
    });
  }

  /* --- 情報表示用コンテナ ---------------------------------------- */
  const infoContainer = div('dfv-info');
  infoContainer.style.cssText = 'margin-top:4px;font-size:0.9em;';
  // テキスト要素を先に作成
  const infoLength  = document.createElement('div');
  const infoPercent = document.createElement('div');
  const infoLayers  = document.createElement('div');
  const infoRot     = document.createElement('div');

  infoLength.className  = 'dfv-rot-infoLength';
  infoPercent.className = 'dfv-rot-infoPercent';
  infoLayers.className  = 'dfv-rot-infoLayers';
  infoRot.className     = 'dfv-rot-infoRot';

  infoContainer.appendChild(infoLength);
  infoContainer.appendChild(infoPercent);
  infoContainer.appendChild(infoLayers);
  infoContainer.appendChild(infoRot);

  mount.appendChild(infoContainer);



  /* -----------------------------------------------------------------
     5-A. 描画更新関数
     -----------------------------------------------------------------*/
  /** 再計算して DOM に反映 */
  function redraw() {
    /* ----- 数学計算 ----- */
    const m = calcMetrics(
      isPresent ? Math.max(0, currentLen) : 0,
      d, r0, h, A, o.reelWindingInnerDiameter
    );
    const remainPct = isPresent ? currentLen / o.filamentTotalLength : 0;
    const usedUp = isPresent && currentLen <= 1e-3 * o.filamentTotalLength;

    /* ----- 直径(px) ----- */
    const solidDiaPx   = Math.max(innerPx, m.Dfloor * geoScale);
    const partialDiaPx = Math.max(solidDiaPx, m.Dnext  * geoScale);

    /* ----- ゲージ直径(px) ----- */
    const gaugeDiaPx = {};
    [1.00, 0.75, 0.50, 0.25, 0.10].forEach(p => {
      const mm = o.filamentTotalLength * p;
      const gm = calcMetrics(mm, d, r0, h, A, o.reelWindingInnerDiameter);
      const dia = Math.max(innerPx,
        (o.reelWindingInnerDiameter + 2 * gm.Nf * h) * geoScale);
      gaugeDiaPx[p] = dia;
    });

    /* ----- 背面/前面 円面 更新 (スプール色は固定) ----- */
    // Hub Face は常にスプール色で表示（透過しない）
    hubBack.style.cssText  = styleCircle(
      innerPx,
      o.reelWindingForegroundColor,
      `translateZ(${-zHalf + zUnit * 1.5}px)`
    );
    hubFront.style.cssText = styleCircle(
      innerPx,
      o.reelWindingForegroundColor,
      `translateZ(${ zHalf - zUnit * 1.5}px)`
    );


    holeBack.style.cssText  = styleCircle(holePx, o.reelCenterHoleForegroundColor,
      `translateZ(${-zHalf + zUnit}px)`);
    holeFront.style.cssText = styleCircle(holePx, o.reelCenterHoleForegroundColor,
      `translateZ(${ zHalf - zUnit}px)`);

    flangeBack.style.background =
      hexToRgba(o.reelBodyColor, o.reelFlangeTransparency);
    flangeFront.style.cssText = styleCircle(
      reelOuterPx,
      hexToRgba(o.reelBodyColor, o.reelFlangeTransparency),
      `translateZ(${zHalf}px)`
    );

    /* ----- フィラメントリング ---- */
    const ringCSS = dia => styleCircle(dia, o.filamentColor);
    filSolidBack.style.cssText  = ringCSS(solidDiaPx)  +
      `transform:translate(-50%,-50%) translateZ(${-zHalf + zUnit * 4}px);`;
    filSolidFront.style.cssText = ringCSS(solidDiaPx)  +
      `transform:translate(-50%,-50%) translateZ(${ zHalf - zUnit * 4}px);`;

    // 最後の1周（Nfull===0）のときはソリッドリングを透過させる
    if (m.Nfull === 0) {
      filSolidBack.style.opacity  = '0';
      filSolidFront.style.opacity = '0';
    } else {
      filSolidBack.style.opacity  = '1';
      filSolidFront.style.opacity = '1';
    }

    if (m.f > 0.010) {
      filPartBack.style.cssText  = ringCSS(partialDiaPx) +
        `opacity:${m.f};transform:translate(-50%,-50%) translateZ(${-zHalf + zUnit * 2}px);`;
      filPartFront.style.cssText = ringCSS(partialDiaPx) +
        `opacity:${m.f};transform:translate(-50%,-50%) translateZ(${ zHalf - zUnit * 2}px);`;
    } else {
      filPartBack.style.cssText  = ringCSS(0);  // サイズ0で隠す
      filPartFront.style.cssText = ringCSS(0);

//      filPartBack.style.cssText = filPartFront.style.cssText = 'display:none;';
    }

    /* ----- ゲージ ---- */
    gauge100Back.style.width = gauge100Back.style.height =
      gauge100Front.style.width = gauge100Front.style.height =
        gaugeDiaPx[1.00] + 'px';

    gauge100Back.style.borderColor =
      gauge100Front.style.borderColor =
        hexToRgba(o.filamentColor, 0.5);

    [0.75,0.50,0.25,0.10].forEach((p,i)=>{
      [otherGBack[i], otherGFront[i]].forEach(g=>{
        g.style.width = g.style.height = gaugeDiaPx[p] + 'px';
        g.style.borderColor = hexToRgba(o.filamentColor, 0.3);
      });
    });

    /* ----- シリンダー側面 ----- */
    filSolidCyl.style.cssText =
      `position:absolute;top:50%;left:50%;width:${solidDiaPx}px;height:${thicknessPx}px;`+
      `transform:translate(-50%,-50%) rotateX(90deg); background:${o.filamentColor};`+
      'border-radius:2px;';
    filPartCyl.style.cssText =
      `position:absolute;top:50%;left:50%;width:${partialDiaPx}px;height:${thicknessPx}px;`+
      `transform:translate(-50%,-50%) rotateX(90deg); background:${o.filamentColor};`+
      `opacity:${m.f};border-radius:2px;`;

    /* ----- シリンダー側面 ----- */
    // Solid Cylinder は最後の1周時にスプール色で表示
    const cylColor = (m.Nfull === 0)
      ? o.reelWindingForegroundColor
      : o.filamentColor;
    filSolidCyl.style.cssText =
      `position:absolute;top:50%;left:50%;width:${solidDiaPx}px;height:${thicknessPx}px;`+
      `transform:translate(-50%,-50%) rotateX(90deg); background:${cylColor};`+
      'border-radius:2px;';


    /* ----- スラッシュ / ライト ----- */
    slash.style.display = ( (usedUp && o.showUsedUpIndicator) || !isPresent ) ? 'block':'none';

    if (slash.style.display === 'block') {
      const color = !isPresent ? 'rgba(59,130,246,0.8)' : 'rgba(239,68,68,0.8)';
      slash.className = 'dfv-blink-slash';
      // ３D 回転から切り離し、常に前景に固定
      slash.style.cssText = `
        position:absolute;
        top:50%; left:50%;
        width:${reelOuterPx*1.50}px; height:10px;
        transform:translate(-50%,-50%) rotate(-47.5deg);
        background:${color};
        border-radius:6px;
        pointer-events:none;
        z-index:10;`;
    }

/*
    if (slash.style.display === 'block') {
      const color = !isPresent ? 'rgba(59,130,246,0.8)' : 'rgba(239,68,68,0.8)';
      slash.className = 'dfv-blink-slash';
      slash.style.cssText = `
        position:absolute;top:50%;left:50%;width:${reelOuterPx*1.125}px;height:10px;
        transform:translate(-50%,-50%) rotate(-45deg) translateZ(${zHalf + zUnit * 2}px);
        background:${color};border-radius:6px;pointer-events:none;`;
    }
*/

    light.style.display = !isPresent ? 'block':'none';
    if (!isPresent) {
      light.className = 'dfv-blink-light';
      light.style.cssText = `
        position:absolute;top:calc(50% - 7.5px);left:calc(50% - 7.5px);
        width:15px;height:15px;border-radius:50%;background:${o.blinkingLightColor};
        box-shadow:0 0 10px ${o.blinkingLightColor};transform:translateZ(${zHalf + zUnit * 3}px);`;
    }

    /* ----- 3D 回転角度正規化 ---- */
    rotX = ((rotX % 720) + 720) % 720; if (rotX >= 360) { rotX -= 720; }
    rotY = ((rotY % 720) + 720) % 720; if (rotY >= 360) { rotY -= 720; }
    rotZ = ((rotZ % 720) + 720) % 720; if (rotZ >= 360) { rotZ -= 720; }

    /* ----- 情報表示更新 ---- */
    infoLength.style.display  = o.showInfoLength  ? 'block' : 'none';
    infoPercent.style.display = o.showInfoPercent ? 'block' : 'none';
    infoLayers.style.display  = o.showInfoLayers  ? 'block' : 'none';
    if (o.showInfoLength) {
      infoLength.textContent  = `Remaining: ${(currentLen/1000).toFixed(1)}m / ${(o.filamentTotalLength/1000).toFixed(1)}m`;
    }
    if (o.showInfoPercent) {
      infoPercent.textContent = `${(isPresent ? (currentLen/o.filamentTotalLength)*100 : 0).toFixed(1)}% full`;
    }
    if (o.showInfoLayers) {
      infoLayers.textContent  = `Approx. ${m.Nf.toFixed(2)} layers remaining`;
    }


    /* ----- 回転情報表示更新 ---- */
    infoRot.style.display = o.showRotationInfo ? 'block' : 'none';
    if (o.showRotationInfo) {
      infoRot.textContent = 
        `X: ${rotX.toFixed(1)}°  Y: ${rotY.toFixed(1)}°  Z: ${rotZ.toFixed(1)}°`;
    }

    /* ----- 3D 回転 ---- */
    //let rotZval = rotZ;

    /* ----- 3D 回転 ---- */
    // rotY を [0,360) に正規化
    const y360 = ((rotY % 360) + 360) % 360;
    // autoRotate 時は、正面(0–180)ならそのまま、背面(180–360)なら Z を反転
    const rotZval = autoRotate
      ? (y360 < 180 ? rotZ : -rotZ)
      : rotZ;

    scene.style.transform = 
      `rotateX(${rotX}deg) rotateY(${rotY}deg) rotateZ(${rotZval}deg)`;

    /* ----- オーバーレイ情報更新 ----- */
    overlayLength.style.display  = o.showOverlayLength  ? 'block' : 'none';
    if (o.showOverlayLength) {
      overlayLength.textContent = o.showLengthKg
        ? `Length: ${(currentLen/1000).toFixed(1)}m / ${(o.filamentTotalLength/1000).toFixed(1)}m`
        : `${(currentLen/1000).toFixed(1)}m`;
    }

    if (o.showLengthKg) {
      overlayLength.textContent += (overlayLength.textContent !="") ? ", " : "";
      overlayLength.textContent += o.filamentWeightKg +"kg";
    }

    // フィラメント名
    overlayName.style.display = o.showReelName ? 'block' : 'none';
    if (o.showReelName) {
      overlayName.textContent   = o.reelName;
    }

    overlaySubName.style.display    = o.showReelSubName ? 'block' : 'none';
    if (o.showReelSubName) {
      overlaySubName.textContent    = o.reelSubName;
    }

    // マテリアル名＋色名
    const matParts = [];
   // if (o.showMaterialName)      matParts.push(o.materialName);
    if (o.showMaterialColorName) matParts.push(o.materialColorName);
    overlayMaterial.style.display = matParts.length ? 'block' : 'none';
    overlayMaterial.textContent   = matParts.join(' / ');

    // カラーコード
    overlayColorCode.style.display = o.showMaterialColorCode ? 'block' : 'none';
    overlayColorCode.textContent   = o.materialColorCode;

    // 残量%
    overlayPercent.style.display = o.showOverlayPercent ? 'block' : 'none';
    if (o.showOverlayPercent) {
      // 数値を整数部・小数点・小数部・％記号に分割
      const pct = (currentLen / o.filamentTotalLength * 100).toFixed(2);
      const [intPart, fracPart] = pct.split('.');
      overlayPercent.innerHTML =
        `<span class="dfv-overlay-percent-int">${intPart}</span>` +
        `<span class="dfv-overlay-percent-dot">.</span>` +
        `<span class="dfv-overlay-percent-frac">${fracPart}</span>` +
        `<span class="dfv-overlay-percent-sign">%</span>`;
    }



    // フィラメントメーカー & リール名
    overlayManufacturer.style.display = o.showManufacturerName ? 'block' : 'none';
    overlayManufacturer.style.cssText = 'font-size:1.2em; font-weight:bold; color:#000; margin:2px 0;';
    overlayManufacturer.textContent = o.manufacturerName || '';

    // 素材種類タグ
    const bg=o.materialColorCode||o.reelWindingForegroundColor;
    materialTag.style.display    =  o.showMaterialName ? 'block':'none';
    materialTag.style.background =  bg;
    materialTag.style.color      =  o.materialColorCode?'#fff':'#000';
    materialTag.textContent      = [o.showMaterialName?o.materialName:null].filter(Boolean).join(' ');
  }

  /* -----------------------------------------------------------------
     5-B. イベントハンドラ
     -----------------------------------------------------------------*/
  /* --- ドラッグ回転 --- */
/*  (function attachDrag() {
    let dragging = false, lastX=0,lastY=0;
    scene.style.cursor = 'grab';

    scene.addEventListener('mousedown', e=>{
      dragging=true; lastX=e.clientX; lastY=e.clientY;
      scene.style.cursor='grabbing';
    });
    window.addEventListener('mousemove', e=>{
      if(!dragging)return;
      const dx=e.clientX-lastX, dy=e.clientY-lastY;
      rotY += dx*0.5;  rotX -= dy*0.5;
      lastX=e.clientX; lastY=e.clientY;
      redraw();
    });
    window.addEventListener('mouseup', ()=>{ dragging=false; scene.style.cursor='grab'; });
  })(); */
  // ドラッグ or クリック制御
  if (o.enableDrag) {
    (function attachDrag() {
      let dragging = false, lastX=0, lastY=0;
      scene.style.cursor = 'grab';
      scene.addEventListener('mousedown', e => {
        dragging = true; lastX = e.clientX; lastY = e.clientY;
        scene.style.cursor = 'grabbing';
      });
      window.addEventListener('mousemove', e => {
        if (!dragging) return;
        const dx = e.clientX - lastX, dy = e.clientY - lastY;
        rotY += dx * 0.5; rotX -= dy * 0.5;
        lastX = e.clientX; lastY = e.clientY;
        redraw();
      });
      window.addEventListener('mouseup', () => {
        dragging = false; scene.style.cursor = 'grab';
      });
    })();
  } else if (o.enableClick && typeof o.onClick === 'function') {
    scene.style.cursor = 'pointer';
    scene.addEventListener('click', o.onClick);
  }


  /* --- スライダー --- */
  slider.addEventListener('input', ()=>{
    currentLen = Number(slider.value);
    redraw();
  });

  /* --- リセット --- */
  btnReset.addEventListener('click', () => {
    rotX = o.initialRotX;
    rotY = o.initialRotY;
    rotZ = o.initialRotZ;
    redraw();
  });

  /* 初回描画 */
  redraw();

  /* -----------------------------------------------------------------
     5-C. 外部 API
     -----------------------------------------------------------------*/
  return {
    /** 残量(mm) を更新 */
    setRemainingLength(mm){
      currentLen = Math.max(0, Math.min(o.filamentTotalLength, mm));
      slider.value = String(currentLen);
      redraw();
    },
    /** 任意オプションを書き換え */
    setOption(key, val){
      if (key in o) { o[key] = val; redraw(); }
    },
    /** 現在のオプションを取得 */
    getOption(key){
      return o[key];
    },
    /** 内部状態を取得 */
    getState(){
      return { rotX, rotY, rotZ, currentLen, isPresent };
    },

    /**
     * isFilamentPresent, showUsedUpIndicator などをまとめて更新
     * @param {Partial<FilamentOptions>} s
     */
    setState(s){
      if ('isFilamentPresent' in s) isPresent = !!s.isFilamentPresent;
      if ('showUsedUpIndicator' in s) o.showUsedUpIndicator = !!s.showUsedUpIndicator;
      if ('filamentCurrentLength' in s) currentLen = s.filamentCurrentLength;
      redraw();
    },

    /** 回転リセット */
    resetRotation(){
      rotX = o.initialRotX;
      rotY = o.initialRotY;
      rotZ = o.initialRotZ;
      redraw();
    }
  };
}