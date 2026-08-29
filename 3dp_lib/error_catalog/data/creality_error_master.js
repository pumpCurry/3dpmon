/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 Creality エラーコードマスター データモジュール
 * @file creality_error_master.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module creality_error_master
 *
 * 【機能内容サマリ】
 * - Creality K1 numeric / Creality OS / CFS エラーコードのマスター定義を提供
 * - namespace、canonical code、機種適用、feature適用、出典、確度を保持
 *
 * 【公開関数一覧】
 * - {@link CREALITY_ERROR_MASTER}：エラーコードマスター全体
 * - {@link CREALITY_ERROR_RECORDS}：resolver が参照するレコード配列
 *
 * @version 1.390.1486 (PR #437)
 * @since   1.390.1486 (PR #437)
 * @lastModified 2026-08-30 02:22:40
 * -----------------------------------------------------------
 * @todo
 * - none
 */

"use strict";

export const CREALITY_ERROR_MASTER = Object.freeze({
  "schemaVersion": 1,
  "generatedAt": "2026-08-30",
  "purpose": "3dpmon Creality printer error-code master; namespace-aware and model/feature-aware",
  "designRules": [
    "raw errcode と raw key は別フィールドとして保存し、同じ数値辞書で二重解釈しない。",
    "K1 numeric と Creality OS の同じ数字は別namespaceとして扱う。",
    "CFSはK2専用ではなくfeature namespaceとして扱う。CFS-C等によりK1系にも適用され得る。",
    "Creality OSのprefixを数値suffixだけから無条件生成しない。",
    "機種不明時にK1へフォールバックしない。",
    "suffix候補を機種/featureで絞って1件だけ残った場合のみcanonical codeを推定する。",
    "曖昧な場合はraw値と候補を表示し、誤った断定メッセージを出さない。"
  ],
  "sources": {
    "k1_official_summary": {
      "tier": "official",
      "title": "K1 Series Error Code Summary",
      "url": "https://wiki.creality.com/en/k1-flagship-series/k1-series-general-documents/error-code-summary",
      "lastEdited": "2024-09-11",
      "scope": "K1-series legacy/numeric error table"
    },
    "k1_general_docs": {
      "tier": "official",
      "title": "K1 Series General Documents",
      "url": "https://wiki.creality.com/en/k1-flagship-series/k1-series-general-documents",
      "lastEdited": "2026-02-03",
      "scope": "Current K1-series troubleshooting index"
    },
    "creality_os_index": {
      "tier": "official",
      "title": "General Documents for FFF Printer / Creality OS Error Code",
      "url": "https://wiki.creality.com/en/printers-general-documents?src=li3d",
      "lastEdited": "2026-03-24",
      "scope": "Current public Creality OS error index"
    },
    "cfs_official_summary": {
      "tier": "official",
      "title": "CFS Error Code Summary",
      "url": "https://wiki.creality.com/en/cfs/error-code-summary",
      "lastEdited": "2024-11-26",
      "scope": "CFS error coding rules and CFS code table"
    },
    "fs2843": {
      "tier": "official",
      "title": "FS2843",
      "url": "https://wiki.creality.com/en/printers-general-documents/FS2843",
      "lastEdited": "2025-08-21",
      "scope": "Exact model applicability"
    },
    "fs2834": {
      "tier": "official",
      "title": "FS2834",
      "url": "https://wiki.creality.com/en/printers-general-documents/FS2834",
      "lastEdited": "2025-08-21",
      "scope": "Exact model applicability"
    },
    "fs2858": {
      "tier": "official",
      "title": "FS2858",
      "url": "https://wiki.creality.com/en/printers-general-documents/FS2858",
      "lastEdited": "2025-08-21",
      "scope": "Exact model applicability"
    },
    "fs2861": {
      "tier": "official",
      "title": "FS2861",
      "url": "https://wiki.creality.com/en/printers-general-documents/FS2861",
      "lastEdited": "2025-08-21",
      "scope": "Exact model applicability"
    },
    "fs2862": {
      "tier": "official",
      "title": "FS2862",
      "url": "https://wiki.creality.com/en/printers-general-documents/FS2862",
      "lastEdited": "2025-08-21",
      "scope": "Exact model applicability"
    },
    "fo0528": {
      "tier": "official",
      "title": "FO0528",
      "url": "https://wiki.creality.com/en/printers-general-documents/FO0528",
      "scope": "Exact model applicability"
    },
    "fo2859": {
      "tier": "official",
      "title": "FO2859",
      "url": "https://wiki.creality.com/en/printers-general-documents/FO2859",
      "lastEdited": "2025-08-21",
      "scope": "Exact model applicability"
    },
    "fr0122": {
      "tier": "official",
      "title": "FR0122",
      "url": "https://wiki.creality.com/en/printers-general-documents/FR0122",
      "lastEdited": "2026-02-09",
      "scope": "Exact model applicability"
    },
    "xs2060": {
      "tier": "official",
      "title": "XS2060",
      "url": "https://wiki.creality.com/en/printers-general-documents/XS2060",
      "lastEdited": "2025-08-21",
      "scope": "Exact model applicability"
    },
    "xs2001": {
      "tier": "official",
      "title": "XS2001",
      "url": "https://wiki.creality.com/en/printers-general-documents/XS2001?src=li3d",
      "scope": "Exact model applicability"
    },
    "xs3002": {
      "tier": "official",
      "title": "XS3002",
      "url": "https://wiki.creality.com/en/printers-general-documents/XS3002",
      "lastEdited": "2025-08-21",
      "scope": "Exact model applicability"
    },
    "ac0500": {
      "tier": "official",
      "title": "AC0500",
      "url": "https://wiki.creality.com/en/printers-general-documents/AC0500",
      "scope": "Exact model applicability"
    },
    "k2_ws_re": {
      "tier": "secondary-reverse-engineering",
      "title": "Creality K2 Plus WebSocket Reverse Engineering",
      "url": "https://github.com/DaviBe92/k2-websocket-re",
      "scope": "Raw K2 port 9999 err={errcode,key,value} transport evidence"
    },
    "creality_print": {
      "tier": "official-source-code",
      "title": "CrealityOfficial/CrealityPrint",
      "url": "https://github.com/CrealityOfficial/CrealityPrint",
      "scope": "HMS/user-facing integration and raw errcode handling"
    },
    "individual_bm0111": {
      "tier": "official",
      "title": "BM0111",
      "url": "https://wiki.creality.com/en/printers-general-documents/BM0111",
      "scope": "Exact model applicability checked during research"
    },
    "individual_bs0508": {
      "tier": "official",
      "title": "BS0508",
      "url": "https://wiki.creality.com/en/printers-general-documents/BS0508",
      "scope": "Exact model applicability checked during research"
    },
    "individual_cb2510": {
      "tier": "official",
      "title": "CB2510",
      "url": "https://wiki.creality.com/en/printers-general-documents/CB2510",
      "scope": "Exact model applicability checked during research"
    },
    "individual_cf0109": {
      "tier": "official",
      "title": "CF0109",
      "url": "https://wiki.creality.com/en/printers-general-documents/CF0109",
      "scope": "Exact model applicability checked during research"
    },
    "individual_cl2536": {
      "tier": "official",
      "title": "CL2536",
      "url": "https://wiki.creality.com/en/printers-general-documents/CL2536",
      "scope": "Exact model applicability checked during research"
    },
    "individual_cm0115": {
      "tier": "official",
      "title": "CM0115",
      "url": "https://wiki.creality.com/en/printers-general-documents/CM0115",
      "scope": "Exact model applicability checked during research"
    },
    "individual_cx2573": {
      "tier": "official",
      "title": "CX2573",
      "url": "https://wiki.creality.com/en/printers-general-documents/CX2573",
      "scope": "Exact model applicability checked during research"
    },
    "individual_cx2585": {
      "tier": "official",
      "title": "CX2585",
      "url": "https://wiki.creality.com/en/printers-general-documents/CX2585",
      "scope": "Exact model applicability checked during research"
    },
    "individual_cy2577": {
      "tier": "official",
      "title": "CY2577",
      "url": "https://wiki.creality.com/en/printers-general-documents/CY2577",
      "scope": "Exact model applicability checked during research"
    },
    "individual_cy2586": {
      "tier": "official",
      "title": "CY2586",
      "url": "https://wiki.creality.com/en/printers-general-documents/CY2586",
      "scope": "Exact model applicability checked during research"
    },
    "individual_cz2587": {
      "tier": "official",
      "title": "CZ2587",
      "url": "https://wiki.creality.com/en/printers-general-documents/CZ2587",
      "scope": "Exact model applicability checked during research"
    },
    "fr5028": {
      "tier": "official",
      "title": "FR5028",
      "url": "https://wiki.creality.com/zh/printers-general-documents/FR5028",
      "scope": "CFS-C/K1C 2025 applicability"
    },
    "individual_te2509": {
      "tier": "official",
      "title": "TE2509",
      "url": "https://wiki.creality.com/en/printers-general-documents/TE2509",
      "scope": "Exact model applicability checked during research"
    },
    "individual_te2564": {
      "tier": "official",
      "title": "TE2564",
      "url": "https://wiki.creality.com/en/printers-general-documents/TE2564",
      "scope": "Exact model applicability checked during research"
    }
  },
  "records": [
    {
      "id": "k1-numeric:100",
      "namespace": "k1-numeric",
      "catalogs": [
        "k1-numeric"
      ],
      "canonicalCode": "100",
      "numericCode": 100,
      "prefix": null,
      "subsystem": "legacy-k1",
      "messageJa": "USB上のG-codeを本体へコピーできません。印刷を開始しないでください。",
      "transportRole": "legacy-key",
      "applicability": {
        "models": [
          "K1 series"
        ],
        "k1": "yes",
        "k2": "no-as-k1-numeric-namespace",
        "features": [],
        "status": "official-series-summary"
      },
      "sources": [
        "k1_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "k1-numeric:101",
      "namespace": "k1-numeric",
      "catalogs": [
        "k1-numeric"
      ],
      "canonicalCode": "101",
      "numericCode": 101,
      "prefix": null,
      "subsystem": "legacy-k1",
      "messageJa": "AIがスパゲッティ状の印刷異常を検出し、印刷を一時停止しました。",
      "transportRole": "legacy-key",
      "applicability": {
        "models": [
          "K1 series"
        ],
        "k1": "yes",
        "k2": "no-as-k1-numeric-namespace",
        "features": [],
        "status": "official-series-summary"
      },
      "sources": [
        "k1_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "k1-numeric:102",
      "namespace": "k1-numeric",
      "catalogs": [
        "k1-numeric"
      ],
      "canonicalCode": "102",
      "numericCode": 102,
      "prefix": null,
      "subsystem": "legacy-k1",
      "messageJa": "G-codeファイル名が長すぎます。",
      "transportRole": "legacy-key",
      "applicability": {
        "models": [
          "K1 series"
        ],
        "k1": "yes",
        "k2": "no-as-k1-numeric-namespace",
        "features": [],
        "status": "official-series-summary"
      },
      "sources": [
        "k1_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "k1-numeric:103",
      "namespace": "k1-numeric",
      "catalogs": [
        "k1-numeric"
      ],
      "canonicalCode": "103",
      "numericCode": 103,
      "prefix": null,
      "subsystem": "legacy-k1",
      "messageJa": "初層品質の異常を検出し、印刷を一時停止しました。",
      "transportRole": "legacy-key",
      "applicability": {
        "models": [
          "K1 series"
        ],
        "k1": "yes",
        "k2": "no-as-k1-numeric-namespace",
        "features": [],
        "status": "official-series-summary"
      },
      "sources": [
        "k1_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "k1-numeric:104",
      "namespace": "k1-numeric",
      "catalogs": [
        "k1-numeric"
      ],
      "canonicalCode": "104",
      "numericCode": 104,
      "prefix": null,
      "subsystem": "legacy-k1",
      "messageJa": "印刷プラットフォーム上の異物を検出し、印刷を一時停止しました。",
      "transportRole": "legacy-key",
      "applicability": {
        "models": [
          "K1 series"
        ],
        "k1": "yes",
        "k2": "no-as-k1-numeric-namespace",
        "features": [],
        "status": "official-series-summary"
      },
      "sources": [
        "k1_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "k1-numeric:108",
      "namespace": "k1-numeric",
      "catalogs": [
        "k1-numeric"
      ],
      "canonicalCode": "108",
      "numericCode": 108,
      "prefix": null,
      "subsystem": "legacy-k1",
      "messageJa": "LiDARのオフセット補正に失敗しました。",
      "transportRole": "legacy-key",
      "applicability": {
        "models": [
          "K1 series"
        ],
        "k1": "yes",
        "k2": "no-as-k1-numeric-namespace",
        "features": [],
        "status": "official-series-summary"
      },
      "sources": [
        "k1_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "k1-numeric:109",
      "namespace": "k1-numeric",
      "catalogs": [
        "k1-numeric"
      ],
      "canonicalCode": "109",
      "numericCode": 109,
      "prefix": null,
      "subsystem": "legacy-k1",
      "messageJa": "ヒートブレイク／スロートファンのフィードバックが異常です。",
      "transportRole": "legacy-key",
      "applicability": {
        "models": [
          "K1 series"
        ],
        "k1": "yes",
        "k2": "no-as-k1-numeric-namespace",
        "features": [],
        "status": "official-series-summary"
      },
      "sources": [
        "k1_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "k1-numeric:110",
      "namespace": "k1-numeric",
      "catalogs": [
        "k1-numeric"
      ],
      "canonicalCode": "110",
      "numericCode": 110,
      "prefix": null,
      "subsystem": "legacy-k1",
      "messageJa": "メインMCUのハードウェア接続が異常です。",
      "transportRole": "legacy-key",
      "applicability": {
        "models": [
          "K1 series"
        ],
        "k1": "yes",
        "k2": "no-as-k1-numeric-namespace",
        "features": [],
        "status": "official-series-summary"
      },
      "sources": [
        "k1_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "k1-numeric:111",
      "namespace": "k1-numeric",
      "catalogs": [
        "k1-numeric"
      ],
      "canonicalCode": "111",
      "numericCode": 111,
      "prefix": null,
      "subsystem": "legacy-k1",
      "messageJa": "ホットエンド／ノズルMCUの接続が異常です。",
      "transportRole": "legacy-key",
      "applicability": {
        "models": [
          "K1 series"
        ],
        "k1": "yes",
        "k2": "no-as-k1-numeric-namespace",
        "features": [],
        "status": "official-series-summary"
      },
      "sources": [
        "k1_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "k1-numeric:112",
      "namespace": "k1-numeric",
      "catalogs": [
        "k1-numeric"
      ],
      "canonicalCode": "112",
      "numericCode": 112,
      "prefix": null,
      "subsystem": "legacy-k1",
      "messageJa": "ヒートベッドMCUの接続が異常です。",
      "transportRole": "legacy-key",
      "applicability": {
        "models": [
          "K1 series"
        ],
        "k1": "yes",
        "k2": "no-as-k1-numeric-namespace",
        "features": [],
        "status": "official-series-summary"
      },
      "sources": [
        "k1_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "k1-numeric:500",
      "namespace": "k1-numeric",
      "catalogs": [
        "k1-numeric"
      ],
      "canonicalCode": "500",
      "numericCode": 500,
      "prefix": null,
      "subsystem": "legacy-k1",
      "messageJa": "AIが印刷品質の問題を検出しました。",
      "transportRole": "legacy-key",
      "applicability": {
        "models": [
          "K1 series"
        ],
        "k1": "yes",
        "k2": "no-as-k1-numeric-namespace",
        "features": [],
        "status": "official-series-summary"
      },
      "sources": [
        "k1_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "k1-numeric:501",
      "namespace": "k1-numeric",
      "catalogs": [
        "k1-numeric"
      ],
      "canonicalCode": "501",
      "numericCode": 501,
      "prefix": null,
      "subsystem": "legacy-k1",
      "messageJa": "ヒートブレイクファンが異常です。",
      "transportRole": "legacy-key",
      "applicability": {
        "models": [
          "K1 series"
        ],
        "k1": "yes",
        "k2": "no-as-k1-numeric-namespace",
        "features": [],
        "status": "official-series-summary"
      },
      "sources": [
        "k1_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "k1-numeric:502",
      "namespace": "k1-numeric",
      "catalogs": [
        "k1-numeric"
      ],
      "canonicalCode": "502",
      "numericCode": 502,
      "prefix": null,
      "subsystem": "legacy-k1",
      "messageJa": "メインボードファンが異常です。",
      "transportRole": "legacy-key",
      "applicability": {
        "models": [
          "K1 series"
        ],
        "k1": "yes",
        "k2": "no-as-k1-numeric-namespace",
        "features": [],
        "status": "official-series-summary"
      },
      "sources": [
        "k1_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "k1-numeric:503",
      "namespace": "k1-numeric",
      "catalogs": [
        "k1-numeric"
      ],
      "canonicalCode": "503",
      "numericCode": 503,
      "prefix": null,
      "subsystem": "legacy-k1",
      "messageJa": "初層検出が異常です。",
      "transportRole": "legacy-key",
      "applicability": {
        "models": [
          "K1 series"
        ],
        "k1": "yes",
        "k2": "no-as-k1-numeric-namespace",
        "features": [],
        "status": "official-series-summary"
      },
      "sources": [
        "k1_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "k1-numeric:504",
      "namespace": "k1-numeric",
      "catalogs": [
        "k1-numeric"
      ],
      "canonicalCode": "504",
      "numericCode": 504,
      "prefix": null,
      "subsystem": "legacy-k1",
      "messageJa": "現在のファイルはフロー検出に対応していません。",
      "transportRole": "legacy-key",
      "applicability": {
        "models": [
          "K1 series"
        ],
        "k1": "yes",
        "k2": "no-as-k1-numeric-namespace",
        "features": [],
        "status": "official-series-summary"
      },
      "sources": [
        "k1_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "k1-numeric:505",
      "namespace": "k1-numeric",
      "catalogs": [
        "k1-numeric"
      ],
      "canonicalCode": "505",
      "numericCode": 505,
      "prefix": null,
      "subsystem": "legacy-k1",
      "messageJa": "AI LiDARが異常です。",
      "transportRole": "legacy-key",
      "applicability": {
        "models": [
          "K1 series"
        ],
        "k1": "yes",
        "k2": "no-as-k1-numeric-namespace",
        "features": [],
        "status": "official-series-summary"
      },
      "sources": [
        "k1_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "k1-numeric:506",
      "namespace": "k1-numeric",
      "catalogs": [
        "k1-numeric"
      ],
      "canonicalCode": "506",
      "numericCode": 506,
      "prefix": null,
      "subsystem": "legacy-k1",
      "messageJa": "AI LiDARのキャリブレーションに失敗しました。",
      "transportRole": "legacy-key",
      "applicability": {
        "models": [
          "K1 series"
        ],
        "k1": "yes",
        "k2": "no-as-k1-numeric-namespace",
        "features": [],
        "status": "official-series-summary"
      },
      "sources": [
        "k1_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "k1-numeric:507",
      "namespace": "k1-numeric",
      "catalogs": [
        "k1-numeric"
      ],
      "canonicalCode": "507",
      "numericCode": 507,
      "prefix": null,
      "subsystem": "legacy-k1",
      "messageJa": "AI LiDARの位置合わせに失敗しました。",
      "transportRole": "legacy-key",
      "applicability": {
        "models": [
          "K1 series"
        ],
        "k1": "yes",
        "k2": "no-as-k1-numeric-namespace",
        "features": [],
        "status": "official-series-summary"
      },
      "sources": [
        "k1_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "k1-numeric:508",
      "namespace": "k1-numeric",
      "catalogs": [
        "k1-numeric"
      ],
      "canonicalCode": "508",
      "numericCode": 508,
      "prefix": null,
      "subsystem": "legacy-k1",
      "messageJa": "ストレージ使用量が制限に達しました。",
      "transportRole": "legacy-key",
      "applicability": {
        "models": [
          "K1 series"
        ],
        "k1": "yes",
        "k2": "no-as-k1-numeric-namespace",
        "features": [],
        "status": "official-series-summary"
      },
      "sources": [
        "k1_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "k1-numeric:2000",
      "namespace": "k1-numeric",
      "catalogs": [
        "k1-numeric"
      ],
      "canonicalCode": "2000",
      "numericCode": 2000,
      "prefix": null,
      "subsystem": "legacy-k1",
      "messageJa": "MCUが停止しているため設定を更新できません。",
      "transportRole": "legacy-key",
      "applicability": {
        "models": [
          "K1 series"
        ],
        "k1": "yes",
        "k2": "no-as-k1-numeric-namespace",
        "features": [],
        "status": "official-series-summary"
      },
      "sources": [
        "k1_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "k1-numeric:2001",
      "namespace": "k1-numeric",
      "catalogs": [
        "k1-numeric"
      ],
      "canonicalCode": "2001",
      "numericCode": 2001,
      "prefix": null,
      "subsystem": "legacy-k1",
      "messageJa": "E軸ドライバICのレジスタ読取りがタイムアウトしました。ホットエンド通信系を確認してください。",
      "transportRole": "legacy-key",
      "applicability": {
        "models": [
          "K1 series"
        ],
        "k1": "yes",
        "k2": "no-as-k1-numeric-namespace",
        "features": [],
        "status": "official-series-summary"
      },
      "sources": [
        "k1_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "k1-numeric:2002",
      "namespace": "k1-numeric",
      "catalogs": [
        "k1-numeric"
      ],
      "canonicalCode": "2002",
      "numericCode": 2002,
      "prefix": null,
      "subsystem": "legacy-k1",
      "messageJa": "メインボード／ホストへ接続できません。",
      "transportRole": "legacy-key",
      "applicability": {
        "models": [
          "K1 series"
        ],
        "k1": "yes",
        "k2": "no-as-k1-numeric-namespace",
        "features": [],
        "status": "official-series-summary"
      },
      "sources": [
        "k1_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "k1-numeric:2014",
      "namespace": "k1-numeric",
      "catalogs": [
        "k1-numeric"
      ],
      "canonicalCode": "2014",
      "numericCode": 2014,
      "prefix": null,
      "subsystem": "legacy-k1",
      "messageJa": "スライス移動距離が不正です。機種・スライサー設定・ファイルを確認してください。",
      "transportRole": "legacy-key",
      "applicability": {
        "models": [
          "K1 series"
        ],
        "k1": "yes",
        "k2": "no-as-k1-numeric-namespace",
        "features": [],
        "status": "official-series-summary"
      },
      "sources": [
        "k1_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "k1-numeric:2016",
      "namespace": "k1-numeric",
      "catalogs": [
        "k1-numeric"
      ],
      "canonicalCode": "2016",
      "numericCode": 2016,
      "prefix": null,
      "subsystem": "legacy-k1",
      "messageJa": "印刷が一時停止状態ではないため、再開処理を中止しました。",
      "transportRole": "legacy-key",
      "applicability": {
        "models": [
          "K1 series"
        ],
        "k1": "yes",
        "k2": "no-as-k1-numeric-namespace",
        "features": [],
        "status": "official-series-summary"
      },
      "sources": [
        "k1_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "k1-numeric:2019",
      "namespace": "k1-numeric",
      "catalogs": [
        "k1-numeric"
      ],
      "canonicalCode": "2019",
      "numericCode": 2019,
      "prefix": null,
      "subsystem": "legacy-k1",
      "messageJa": "目標温度が設定可能範囲外です。",
      "transportRole": "legacy-key",
      "applicability": {
        "models": [
          "K1 series"
        ],
        "k1": "yes",
        "k2": "no-as-k1-numeric-namespace",
        "features": [],
        "status": "official-series-summary"
      },
      "sources": [
        "k1_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "k1-numeric:2020",
      "namespace": "k1-numeric",
      "catalogs": [
        "k1-numeric"
      ],
      "canonicalCode": "2020",
      "numericCode": 2020,
      "prefix": null,
      "subsystem": "legacy-k1",
      "messageJa": "原点復帰処理でエラーが発生しました。",
      "transportRole": "legacy-key",
      "applicability": {
        "models": [
          "K1 series"
        ],
        "k1": "yes",
        "k2": "no-as-k1-numeric-namespace",
        "features": [],
        "status": "official-series-summary"
      },
      "sources": [
        "k1_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "k1-numeric:2021",
      "namespace": "k1-numeric",
      "catalogs": [
        "k1-numeric"
      ],
      "canonicalCode": "2021",
      "numericCode": 2021,
      "prefix": null,
      "subsystem": "legacy-k1",
      "messageJa": "原点復帰がタイムアウトしました。",
      "transportRole": "legacy-key",
      "applicability": {
        "models": [
          "K1 series"
        ],
        "k1": "yes",
        "k2": "no-as-k1-numeric-namespace",
        "features": [],
        "status": "official-series-summary"
      },
      "sources": [
        "k1_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "k1-numeric:2056",
      "namespace": "k1-numeric",
      "catalogs": [
        "k1-numeric"
      ],
      "canonicalCode": "2056",
      "numericCode": 2056,
      "prefix": null,
      "subsystem": "legacy-k1",
      "messageJa": "軸加速度センサーからデータを取得できません。",
      "transportRole": "legacy-key",
      "applicability": {
        "models": [
          "K1 series"
        ],
        "k1": "yes",
        "k2": "no-as-k1-numeric-namespace",
        "features": [],
        "status": "official-series-summary"
      },
      "sources": [
        "k1_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "k1-numeric:2057",
      "namespace": "k1-numeric",
      "catalogs": [
        "k1-numeric"
      ],
      "canonicalCode": "2057",
      "numericCode": 2057,
      "prefix": null,
      "subsystem": "legacy-k1",
      "messageJa": "不明な例外が発生しました。",
      "transportRole": "legacy-key",
      "applicability": {
        "models": [
          "K1 series"
        ],
        "k1": "yes",
        "k2": "no-as-k1-numeric-namespace",
        "features": [],
        "status": "official-series-summary"
      },
      "sources": [
        "k1_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "k1-numeric:2060",
      "namespace": "k1-numeric",
      "catalogs": [
        "k1-numeric"
      ],
      "canonicalCode": "2060",
      "numericCode": 2060,
      "prefix": null,
      "subsystem": "legacy-k1",
      "messageJa": "ホットエンド端子または通信系に異常があります。",
      "transportRole": "legacy-key",
      "applicability": {
        "models": [
          "K1 series"
        ],
        "k1": "yes",
        "k2": "no-as-k1-numeric-namespace",
        "features": [],
        "status": "official-series-summary"
      },
      "sources": [
        "k1_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "k1-numeric:2065",
      "namespace": "k1-numeric",
      "catalogs": [
        "k1-numeric"
      ],
      "canonicalCode": "2065",
      "numericCode": 2065,
      "prefix": null,
      "subsystem": "legacy-k1",
      "messageJa": "ADXL345レジスタ設定に失敗しました。配線またはセンサー異常の可能性があります。",
      "transportRole": "legacy-key",
      "applicability": {
        "models": [
          "K1 series"
        ],
        "k1": "yes",
        "k2": "no-as-k1-numeric-namespace",
        "features": [],
        "status": "official-series-summary"
      },
      "sources": [
        "k1_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "k1-numeric:2069",
      "namespace": "k1-numeric",
      "catalogs": [
        "k1-numeric"
      ],
      "canonicalCode": "2069",
      "numericCode": 2069,
      "prefix": null,
      "subsystem": "legacy-k1",
      "messageJa": "スライスファイルに非対応の「M107 P3」が含まれています。",
      "transportRole": "legacy-key",
      "applicability": {
        "models": [
          "K1 series"
        ],
        "k1": "yes",
        "k2": "no-as-k1-numeric-namespace",
        "features": [],
        "status": "official-series-summary"
      },
      "sources": [
        "k1_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "k1-numeric:2090",
      "namespace": "k1-numeric",
      "catalogs": [
        "k1-numeric"
      ],
      "canonicalCode": "2090",
      "numericCode": 2090,
      "prefix": null,
      "subsystem": "legacy-k1",
      "messageJa": "タイマー処理が間に合っていません。ホスト過負荷の可能性があります。",
      "transportRole": "legacy-key",
      "applicability": {
        "models": [
          "K1 series"
        ],
        "k1": "yes",
        "k2": "no-as-k1-numeric-namespace",
        "features": [],
        "status": "official-series-summary"
      },
      "sources": [
        "k1_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "k1-numeric:2091",
      "namespace": "k1-numeric",
      "catalogs": [
        "k1-numeric"
      ],
      "canonicalCode": "2091",
      "numericCode": 2091,
      "prefix": null,
      "subsystem": "legacy-k1",
      "messageJa": "MCUとホスト間の一時的な通信失敗によりスケジュールを逃しました。",
      "transportRole": "legacy-key",
      "applicability": {
        "models": [
          "K1 series"
        ],
        "k1": "yes",
        "k2": "no-as-k1-numeric-namespace",
        "features": [],
        "status": "official-series-summary"
      },
      "sources": [
        "k1_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "k1-numeric:2095",
      "namespace": "k1-numeric",
      "catalogs": [
        "k1-numeric"
      ],
      "canonicalCode": "2095",
      "numericCode": 2095,
      "prefix": null,
      "subsystem": "legacy-k1",
      "messageJa": "先に原点復帰を実行する必要があります。",
      "transportRole": "legacy-key",
      "applicability": {
        "models": [
          "K1 series"
        ],
        "k1": "yes",
        "k2": "no-as-k1-numeric-namespace",
        "features": [],
        "status": "official-series-summary"
      },
      "sources": [
        "k1_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "k1-numeric:2111",
      "namespace": "k1-numeric",
      "catalogs": [
        "k1-numeric"
      ],
      "canonicalCode": "2111",
      "numericCode": 2111,
      "prefix": null,
      "subsystem": "legacy-k1",
      "messageJa": "押出温度が最低押出温度（CrealityOSでは170℃）未満です。",
      "transportRole": "legacy-key",
      "applicability": {
        "models": [
          "K1 series"
        ],
        "k1": "yes",
        "k2": "no-as-k1-numeric-namespace",
        "features": [],
        "status": "official-series-summary"
      },
      "sources": [
        "k1_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "k1-numeric:2112",
      "namespace": "k1-numeric",
      "catalogs": [
        "k1-numeric"
      ],
      "canonicalCode": "2112",
      "numericCode": 2112,
      "prefix": null,
      "subsystem": "legacy-k1",
      "messageJa": "押出断面積が上限を超えています。",
      "transportRole": "legacy-key",
      "applicability": {
        "models": [
          "K1 series"
        ],
        "k1": "yes",
        "k2": "no-as-k1-numeric-namespace",
        "features": [],
        "status": "official-series-summary"
      },
      "sources": [
        "k1_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "k1-numeric:2113",
      "namespace": "k1-numeric",
      "catalogs": [
        "k1-numeric"
      ],
      "canonicalCode": "2113",
      "numericCode": 2113,
      "prefix": null,
      "subsystem": "legacy-k1",
      "messageJa": "押出機の設定が無効です。",
      "transportRole": "legacy-key",
      "applicability": {
        "models": [
          "K1 series"
        ],
        "k1": "yes",
        "k2": "no-as-k1-numeric-namespace",
        "features": [],
        "status": "official-series-summary"
      },
      "sources": [
        "k1_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "k1-numeric:2114",
      "namespace": "k1-numeric",
      "catalogs": [
        "k1-numeric"
      ],
      "canonicalCode": "2114",
      "numericCode": 2114,
      "prefix": null,
      "subsystem": "legacy-k1",
      "messageJa": "押出機が存在しない状態で押出命令が実行されました。",
      "transportRole": "legacy-key",
      "applicability": {
        "models": [
          "K1 series"
        ],
        "k1": "yes",
        "k2": "no-as-k1-numeric-namespace",
        "features": [],
        "status": "official-series-summary"
      },
      "sources": [
        "k1_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "k1-numeric:2115",
      "namespace": "k1-numeric",
      "catalogs": [
        "k1-numeric"
      ],
      "canonicalCode": "2115",
      "numericCode": 2115,
      "prefix": null,
      "subsystem": "legacy-k1",
      "messageJa": "列挙値が無効です。",
      "transportRole": "legacy-key",
      "applicability": {
        "models": [
          "K1 series"
        ],
        "k1": "yes",
        "k2": "no-as-k1-numeric-namespace",
        "features": [],
        "status": "official-series-summary"
      },
      "sources": [
        "k1_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "k1-numeric:2116",
      "namespace": "k1-numeric",
      "catalogs": [
        "k1-numeric"
      ],
      "canonicalCode": "2116",
      "numericCode": 2116,
      "prefix": null,
      "subsystem": "legacy-k1",
      "messageJa": "出力形式が無効です。",
      "transportRole": "legacy-key",
      "applicability": {
        "models": [
          "K1 series"
        ],
        "k1": "yes",
        "k2": "no-as-k1-numeric-namespace",
        "features": [],
        "status": "official-series-summary"
      },
      "sources": [
        "k1_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "k1-numeric:2117",
      "namespace": "k1-numeric",
      "catalogs": [
        "k1-numeric"
      ],
      "canonicalCode": "2117",
      "numericCode": 2117,
      "prefix": null,
      "subsystem": "legacy-k1",
      "messageJa": "メッセージ末尾に余分なデータがあります。",
      "transportRole": "legacy-key",
      "applicability": {
        "models": [
          "K1 series"
        ],
        "k1": "yes",
        "k2": "no-as-k1-numeric-namespace",
        "features": [],
        "status": "official-series-summary"
      },
      "sources": [
        "k1_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "k1-numeric:2118",
      "namespace": "k1-numeric",
      "catalogs": [
        "k1-numeric"
      ],
      "canonicalCode": "2118",
      "numericCode": 2118,
      "prefix": null,
      "subsystem": "legacy-k1",
      "messageJa": "ADXL345 FIFOを照会できません。",
      "transportRole": "legacy-key",
      "applicability": {
        "models": [
          "K1 series"
        ],
        "k1": "yes",
        "k2": "no-as-k1-numeric-namespace",
        "features": [],
        "status": "official-series-summary"
      },
      "sources": [
        "k1_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "k1-numeric:2119",
      "namespace": "k1-numeric",
      "catalogs": [
        "k1-numeric"
      ],
      "canonicalCode": "2119",
      "numericCode": 2119,
      "prefix": null,
      "subsystem": "legacy-k1",
      "messageJa": "ADXL345のIDが無効です。",
      "transportRole": "legacy-key",
      "applicability": {
        "models": [
          "K1 series"
        ],
        "k1": "yes",
        "k2": "no-as-k1-numeric-namespace",
        "features": [],
        "status": "official-series-summary"
      },
      "sources": [
        "k1_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "k1-numeric:2210",
      "namespace": "k1-numeric",
      "catalogs": [
        "k1-numeric"
      ],
      "canonicalCode": "2210",
      "numericCode": 2210,
      "prefix": null,
      "subsystem": "legacy-k1",
      "messageJa": "押出機が最低温度未満のため、自動フィラメントロードできません。",
      "transportRole": "legacy-key",
      "applicability": {
        "models": [
          "K1 series"
        ],
        "k1": "yes",
        "k2": "no-as-k1-numeric-namespace",
        "features": [],
        "status": "official-series-summary"
      },
      "sources": [
        "k1_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "k1-numeric:2211",
      "namespace": "k1-numeric",
      "catalogs": [
        "k1-numeric"
      ],
      "canonicalCode": "2211",
      "numericCode": 2211,
      "prefix": null,
      "subsystem": "legacy-k1",
      "messageJa": "印刷が一時停止されました。",
      "transportRole": "legacy-key",
      "applicability": {
        "models": [
          "K1 series"
        ],
        "k1": "yes",
        "k2": "no-as-k1-numeric-namespace",
        "features": [],
        "status": "official-series-summary"
      },
      "sources": [
        "k1_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "k1-numeric:2242",
      "namespace": "k1-numeric",
      "catalogs": [
        "k1-numeric"
      ],
      "canonicalCode": "2242",
      "numericCode": 2242,
      "prefix": null,
      "subsystem": "legacy-k1",
      "messageJa": "先に原点復帰してください。",
      "transportRole": "legacy-key",
      "applicability": {
        "models": [
          "K1 series"
        ],
        "k1": "yes",
        "k2": "no-as-k1-numeric-namespace",
        "features": [],
        "status": "official-series-summary"
      },
      "sources": [
        "k1_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "k1-numeric:2243",
      "namespace": "k1-numeric",
      "catalogs": [
        "k1-numeric"
      ],
      "canonicalCode": "2243",
      "numericCode": 2243,
      "prefix": null,
      "subsystem": "legacy-k1",
      "messageJa": "座標が可動範囲外です。",
      "transportRole": "legacy-key",
      "applicability": {
        "models": [
          "K1 series"
        ],
        "k1": "yes",
        "k2": "no-as-k1-numeric-namespace",
        "features": [],
        "status": "official-series-summary"
      },
      "sources": [
        "k1_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "k1-numeric:2252",
      "namespace": "k1-numeric",
      "catalogs": [
        "k1-numeric"
      ],
      "canonicalCode": "2252",
      "numericCode": 2252,
      "prefix": null,
      "subsystem": "legacy-k1",
      "messageJa": "パラメータが最小値を下回っています。",
      "transportRole": "legacy-key",
      "applicability": {
        "models": [
          "K1 series"
        ],
        "k1": "yes",
        "k2": "no-as-k1-numeric-namespace",
        "features": [],
        "status": "official-series-summary"
      },
      "sources": [
        "k1_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "k1-numeric:2253",
      "namespace": "k1-numeric",
      "catalogs": [
        "k1-numeric"
      ],
      "canonicalCode": "2253",
      "numericCode": 2253,
      "prefix": null,
      "subsystem": "legacy-k1",
      "messageJa": "パラメータが最大値を上回っています。",
      "transportRole": "legacy-key",
      "applicability": {
        "models": [
          "K1 series"
        ],
        "k1": "yes",
        "k2": "no-as-k1-numeric-namespace",
        "features": [],
        "status": "official-series-summary"
      },
      "sources": [
        "k1_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "k1-numeric:2283",
      "namespace": "k1-numeric",
      "catalogs": [
        "k1-numeric"
      ],
      "canonicalCode": "2283",
      "numericCode": 2283,
      "prefix": null,
      "subsystem": "legacy-k1",
      "messageJa": "プリンターが準備できていません。",
      "transportRole": "legacy-key",
      "applicability": {
        "models": [
          "K1 series"
        ],
        "k1": "yes",
        "k2": "no-as-k1-numeric-namespace",
        "features": [],
        "status": "official-series-summary"
      },
      "sources": [
        "k1_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "k1-numeric:2294",
      "namespace": "k1-numeric",
      "catalogs": [
        "k1-numeric"
      ],
      "canonicalCode": "2294",
      "numericCode": 2294,
      "prefix": null,
      "subsystem": "legacy-k1",
      "messageJa": "応答がタイムアウトしました。",
      "transportRole": "legacy-key",
      "applicability": {
        "models": [
          "K1 series"
        ],
        "k1": "yes",
        "k2": "no-as-k1-numeric-namespace",
        "features": [],
        "status": "official-series-summary"
      },
      "sources": [
        "k1_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "k1-numeric:2295",
      "namespace": "k1-numeric",
      "catalogs": [
        "k1-numeric"
      ],
      "canonicalCode": "2295",
      "numericCode": 2295,
      "prefix": null,
      "subsystem": "legacy-k1",
      "messageJa": "MCUの再起動に失敗しました。",
      "transportRole": "legacy-key",
      "applicability": {
        "models": [
          "K1 series"
        ],
        "k1": "yes",
        "k2": "no-as-k1-numeric-namespace",
        "features": [],
        "status": "official-series-summary"
      },
      "sources": [
        "k1_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "k1-numeric:2298",
      "namespace": "k1-numeric",
      "catalogs": [
        "k1-numeric"
      ],
      "canonicalCode": "2298",
      "numericCode": 2298,
      "prefix": null,
      "subsystem": "legacy-k1",
      "messageJa": "MCUの電源が切れているため設定を更新できません。",
      "transportRole": "legacy-key",
      "applicability": {
        "models": [
          "K1 series"
        ],
        "k1": "yes",
        "k2": "no-as-k1-numeric-namespace",
        "features": [],
        "status": "official-series-summary"
      },
      "sources": [
        "k1_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "k1-numeric:2299",
      "namespace": "k1-numeric",
      "catalogs": [
        "k1-numeric"
      ],
      "canonicalCode": "2299",
      "numericCode": 2299,
      "prefix": null,
      "subsystem": "legacy-k1",
      "messageJa": "MCUを設定できません。",
      "transportRole": "legacy-key",
      "applicability": {
        "models": [
          "K1 series"
        ],
        "k1": "yes",
        "k2": "no-as-k1-numeric-namespace",
        "features": [],
        "status": "official-series-summary"
      },
      "sources": [
        "k1_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "k1-numeric:2300",
      "namespace": "k1-numeric",
      "catalogs": [
        "k1-numeric"
      ],
      "canonicalCode": "2300",
      "numericCode": 2300,
      "prefix": null,
      "subsystem": "legacy-k1",
      "messageJa": "MCU設定中にエラーが発生しました。",
      "transportRole": "legacy-key",
      "applicability": {
        "models": [
          "K1 series"
        ],
        "k1": "yes",
        "k2": "no-as-k1-numeric-namespace",
        "features": [],
        "status": "official-series-summary"
      },
      "sources": [
        "k1_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "k1-numeric:2308",
      "namespace": "k1-numeric",
      "catalogs": [
        "k1-numeric"
      ],
      "canonicalCode": "2308",
      "numericCode": 2308,
      "prefix": null,
      "subsystem": "legacy-k1",
      "messageJa": "軸加速度センサーでデータを測定できません。",
      "transportRole": "legacy-key",
      "applicability": {
        "models": [
          "K1 series"
        ],
        "k1": "yes",
        "k2": "no-as-k1-numeric-namespace",
        "features": [],
        "status": "official-series-summary"
      },
      "sources": [
        "k1_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "k1-numeric:2313",
      "namespace": "k1-numeric",
      "catalogs": [
        "k1-numeric"
      ],
      "canonicalCode": "2313",
      "numericCode": 2313,
      "prefix": null,
      "subsystem": "legacy-k1",
      "messageJa": "加速度センサーデータ処理中に内部エラーが発生しました。",
      "transportRole": "legacy-key",
      "applicability": {
        "models": [
          "K1 series"
        ],
        "k1": "yes",
        "k2": "no-as-k1-numeric-namespace",
        "features": [],
        "status": "official-series-summary"
      },
      "sources": [
        "k1_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "k1-numeric:2340",
      "namespace": "k1-numeric",
      "catalogs": [
        "k1-numeric"
      ],
      "canonicalCode": "2340",
      "numericCode": 2340,
      "prefix": null,
      "subsystem": "legacy-k1",
      "messageJa": "ヒーター要求温度が許容範囲外です。",
      "transportRole": "legacy-key",
      "applicability": {
        "models": [
          "K1 series"
        ],
        "k1": "yes",
        "k2": "no-as-k1-numeric-namespace",
        "features": [],
        "status": "official-series-summary"
      },
      "sources": [
        "k1_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "k1-numeric:2343",
      "namespace": "k1-numeric",
      "catalogs": [
        "k1-numeric"
      ],
      "canonicalCode": "2343",
      "numericCode": 2343,
      "prefix": null,
      "subsystem": "legacy-k1",
      "messageJa": "メインMCUとの接続がタイムアウトしました。",
      "transportRole": "legacy-key",
      "applicability": {
        "models": [
          "K1 series"
        ],
        "k1": "yes",
        "k2": "no-as-k1-numeric-namespace",
        "features": [],
        "status": "official-series-summary"
      },
      "sources": [
        "k1_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "k1-numeric:2344",
      "namespace": "k1-numeric",
      "catalogs": [
        "k1-numeric"
      ],
      "canonicalCode": "2344",
      "numericCode": 2344,
      "prefix": null,
      "subsystem": "legacy-k1",
      "messageJa": "ホットエンドMCUとの接続がタイムアウトしました。",
      "transportRole": "legacy-key",
      "applicability": {
        "models": [
          "K1 series"
        ],
        "k1": "yes",
        "k2": "no-as-k1-numeric-namespace",
        "features": [],
        "status": "official-series-summary"
      },
      "sources": [
        "k1_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "k1-numeric:2345",
      "namespace": "k1-numeric",
      "catalogs": [
        "k1-numeric"
      ],
      "canonicalCode": "2345",
      "numericCode": 2345,
      "prefix": null,
      "subsystem": "legacy-k1",
      "messageJa": "ヒートベッドMCUとの接続がタイムアウトしました。",
      "transportRole": "legacy-key",
      "applicability": {
        "models": [
          "K1 series"
        ],
        "k1": "yes",
        "k2": "no-as-k1-numeric-namespace",
        "features": [],
        "status": "official-series-summary"
      },
      "sources": [
        "k1_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "k1-numeric:2503",
      "namespace": "k1-numeric",
      "catalogs": [
        "k1-numeric"
      ],
      "canonicalCode": "2503",
      "numericCode": 2503,
      "prefix": null,
      "subsystem": "legacy-k1",
      "messageJa": "Z軸のひずみゲージ／圧力センサーを読み取れません。",
      "transportRole": "legacy-key",
      "applicability": {
        "models": [
          "K1 series"
        ],
        "k1": "yes",
        "k2": "no-as-k1-numeric-namespace",
        "features": [],
        "status": "official-series-summary"
      },
      "sources": [
        "k1_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "k1-numeric:2504",
      "namespace": "k1-numeric",
      "catalogs": [
        "k1-numeric"
      ],
      "canonicalCode": "2504",
      "numericCode": 2504,
      "prefix": null,
      "subsystem": "legacy-k1",
      "messageJa": "Z軸原点復帰が異常です。",
      "transportRole": "legacy-key",
      "applicability": {
        "models": [
          "K1 series"
        ],
        "k1": "yes",
        "k2": "no-as-k1-numeric-namespace",
        "features": [],
        "status": "official-series-summary"
      },
      "sources": [
        "k1_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "k1-numeric:2505",
      "namespace": "k1-numeric",
      "catalogs": [
        "k1-numeric"
      ],
      "canonicalCode": "2505",
      "numericCode": 2505,
      "prefix": null,
      "subsystem": "legacy-k1",
      "messageJa": "TMCモータードライバが異常です。",
      "transportRole": "legacy-key",
      "applicability": {
        "models": [
          "K1 series"
        ],
        "k1": "yes",
        "k2": "no-as-k1-numeric-namespace",
        "features": [],
        "status": "official-series-summary"
      },
      "sources": [
        "k1_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "k1-numeric:2506",
      "namespace": "k1-numeric",
      "catalogs": [
        "k1-numeric"
      ],
      "canonicalCode": "2506",
      "numericCode": 2506,
      "prefix": null,
      "subsystem": "legacy-k1",
      "messageJa": "通信が異常です。",
      "transportRole": "legacy-key",
      "applicability": {
        "models": [
          "K1 series"
        ],
        "k1": "yes",
        "k2": "no-as-k1-numeric-namespace",
        "features": [],
        "status": "official-series-summary"
      },
      "sources": [
        "k1_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "k1-numeric:2509",
      "namespace": "k1-numeric",
      "catalogs": [
        "k1-numeric"
      ],
      "canonicalCode": "2509",
      "numericCode": 2509,
      "prefix": null,
      "subsystem": "legacy-k1",
      "messageJa": "ノズル温度センサーが異常／断線しています。",
      "transportRole": "legacy-key",
      "applicability": {
        "models": [
          "K1 series"
        ],
        "k1": "yes",
        "k2": "no-as-k1-numeric-namespace",
        "features": [],
        "status": "official-series-summary"
      },
      "sources": [
        "k1_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "k1-numeric:2510",
      "namespace": "k1-numeric",
      "catalogs": [
        "k1-numeric"
      ],
      "canonicalCode": "2510",
      "numericCode": 2510,
      "prefix": null,
      "subsystem": "legacy-k1",
      "messageJa": "ベッド温度センサーが異常です。",
      "transportRole": "legacy-key",
      "applicability": {
        "models": [
          "K1 series"
        ],
        "k1": "yes",
        "k2": "no-as-k1-numeric-namespace",
        "features": [],
        "status": "official-series-summary"
      },
      "sources": [
        "k1_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "k1-numeric:2511",
      "namespace": "k1-numeric",
      "catalogs": [
        "k1-numeric"
      ],
      "canonicalCode": "2511",
      "numericCode": 2511,
      "prefix": null,
      "subsystem": "legacy-k1",
      "messageJa": "チャンバー温度センサーが異常です。",
      "transportRole": "legacy-key",
      "applicability": {
        "models": [
          "K1 series"
        ],
        "k1": "yes",
        "k2": "no-as-k1-numeric-namespace",
        "features": [],
        "status": "official-series-summary"
      },
      "sources": [
        "k1_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "k1-numeric:2512",
      "namespace": "k1-numeric",
      "catalogs": [
        "k1-numeric"
      ],
      "canonicalCode": "2512",
      "numericCode": 2512,
      "prefix": null,
      "subsystem": "legacy-k1",
      "messageJa": "メインMCUチップ温度が異常です。",
      "transportRole": "legacy-key",
      "applicability": {
        "models": [
          "K1 series"
        ],
        "k1": "yes",
        "k2": "no-as-k1-numeric-namespace",
        "features": [],
        "status": "official-series-summary"
      },
      "sources": [
        "k1_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "k1-numeric:2513",
      "namespace": "k1-numeric",
      "catalogs": [
        "k1-numeric"
      ],
      "canonicalCode": "2513",
      "numericCode": 2513,
      "prefix": null,
      "subsystem": "legacy-k1",
      "messageJa": "コマンド形式が不正です。",
      "transportRole": "legacy-key",
      "applicability": {
        "models": [
          "K1 series"
        ],
        "k1": "yes",
        "k2": "no-as-k1-numeric-namespace",
        "features": [],
        "status": "official-series-summary"
      },
      "sources": [
        "k1_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "k1-numeric:2514",
      "namespace": "k1-numeric",
      "catalogs": [
        "k1-numeric"
      ],
      "canonicalCode": "2514",
      "numericCode": 2514,
      "prefix": null,
      "subsystem": "legacy-k1",
      "messageJa": "コマンドのパラメータ形式が不正です。",
      "transportRole": "legacy-key",
      "applicability": {
        "models": [
          "K1 series"
        ],
        "k1": "yes",
        "k2": "no-as-k1-numeric-namespace",
        "features": [],
        "status": "official-series-summary"
      },
      "sources": [
        "k1_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "k1-numeric:2520",
      "namespace": "k1-numeric",
      "catalogs": [
        "k1-numeric"
      ],
      "canonicalCode": "2520",
      "numericCode": 2520,
      "prefix": null,
      "subsystem": "legacy-k1",
      "messageJa": "HX711圧力読取りがタイムアウトしました。",
      "transportRole": "legacy-key",
      "applicability": {
        "models": [
          "K1 series"
        ],
        "k1": "yes",
        "k2": "no-as-k1-numeric-namespace",
        "features": [],
        "status": "official-series-summary"
      },
      "sources": [
        "k1_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "k1-numeric:2521",
      "namespace": "k1-numeric",
      "catalogs": [
        "k1-numeric"
      ],
      "canonicalCode": "2521",
      "numericCode": 2521,
      "prefix": null,
      "subsystem": "legacy-k1",
      "messageJa": "レベリングセンサーチップが異常または破損しています。",
      "transportRole": "legacy-key",
      "applicability": {
        "models": [
          "K1 series"
        ],
        "k1": "yes",
        "k2": "no-as-k1-numeric-namespace",
        "features": [],
        "status": "official-series-summary"
      },
      "sources": [
        "k1_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "k1-numeric:2522",
      "namespace": "k1-numeric",
      "catalogs": [
        "k1-numeric"
      ],
      "canonicalCode": "2522",
      "numericCode": 2522,
      "prefix": null,
      "subsystem": "legacy-k1",
      "messageJa": "レベリングセンサーのデータ伝送／圧力変化が異常です。",
      "transportRole": "legacy-key",
      "applicability": {
        "models": [
          "K1 series"
        ],
        "k1": "yes",
        "k2": "no-as-k1-numeric-namespace",
        "features": [],
        "status": "official-series-summary"
      },
      "sources": [
        "k1_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "k1-numeric:2523",
      "namespace": "k1-numeric",
      "catalogs": [
        "k1-numeric"
      ],
      "canonicalCode": "2523",
      "numericCode": 2523,
      "prefix": null,
      "subsystem": "legacy-k1",
      "messageJa": "レベリングセンサーでパケット損失またはZ動作タイムアウトが発生しました。",
      "transportRole": "legacy-key",
      "applicability": {
        "models": [
          "K1 series"
        ],
        "k1": "yes",
        "k2": "no-as-k1-numeric-namespace",
        "features": [],
        "status": "official-series-summary"
      },
      "sources": [
        "k1_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "k1-numeric:2524",
      "namespace": "k1-numeric",
      "catalogs": [
        "k1-numeric"
      ],
      "canonicalCode": "2524",
      "numericCode": 2524,
      "prefix": null,
      "subsystem": "legacy-k1",
      "messageJa": "レベリングセンサーのノイズ／環境干渉が大きすぎます。",
      "transportRole": "legacy-key",
      "applicability": {
        "models": [
          "K1 series"
        ],
        "k1": "yes",
        "k2": "no-as-k1-numeric-namespace",
        "features": [],
        "status": "official-series-summary"
      },
      "sources": [
        "k1_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "k1-numeric:2526",
      "namespace": "k1-numeric",
      "catalogs": [
        "k1-numeric"
      ],
      "canonicalCode": "2526",
      "numericCode": 2526,
      "prefix": null,
      "subsystem": "legacy-k1",
      "messageJa": "Z軸移動が滑らかでない、またはステップロスの可能性があります。",
      "transportRole": "legacy-key",
      "applicability": {
        "models": [
          "K1 series"
        ],
        "k1": "yes",
        "k2": "no-as-k1-numeric-namespace",
        "features": [],
        "status": "official-series-summary"
      },
      "sources": [
        "k1_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "k1-numeric:2527",
      "namespace": "k1-numeric",
      "catalogs": [
        "k1-numeric"
      ],
      "canonicalCode": "2527",
      "numericCode": 2527,
      "prefix": null,
      "subsystem": "legacy-k1",
      "messageJa": "レベリングセンサーのデータパケットが失われました。",
      "transportRole": "legacy-key",
      "applicability": {
        "models": [
          "K1 series"
        ],
        "k1": "yes",
        "k2": "no-as-k1-numeric-namespace",
        "features": [],
        "status": "official-series-summary"
      },
      "sources": [
        "k1_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "k1-numeric:2529",
      "namespace": "k1-numeric",
      "catalogs": [
        "k1-numeric"
      ],
      "canonicalCode": "2529",
      "numericCode": 2529,
      "prefix": null,
      "subsystem": "legacy-k1",
      "messageJa": "G28 Z原点復帰の測定回数が上限を超えました。",
      "transportRole": "legacy-key",
      "applicability": {
        "models": [
          "K1 series"
        ],
        "k1": "yes",
        "k2": "no-as-k1-numeric-namespace",
        "features": [],
        "status": "official-series-summary"
      },
      "sources": [
        "k1_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "k1-numeric:2532",
      "namespace": "k1-numeric",
      "catalogs": [
        "k1-numeric"
      ],
      "canonicalCode": "2532",
      "numericCode": 2532,
      "prefix": null,
      "subsystem": "legacy-k1",
      "messageJa": "MCU同期線が異常／接触不良です。",
      "transportRole": "legacy-key",
      "applicability": {
        "models": [
          "K1 series"
        ],
        "k1": "yes",
        "k2": "no-as-k1-numeric-namespace",
        "features": [],
        "status": "official-series-summary"
      },
      "sources": [
        "k1_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "k1-numeric:2533",
      "namespace": "k1-numeric",
      "catalogs": [
        "k1-numeric"
      ],
      "canonicalCode": "2533",
      "numericCode": 2533,
      "prefix": null,
      "subsystem": "legacy-k1",
      "messageJa": "ベッドメッシュ検査のパラメータが異常です。",
      "transportRole": "legacy-key",
      "applicability": {
        "models": [
          "K1 series"
        ],
        "k1": "yes",
        "k2": "no-as-k1-numeric-namespace",
        "features": [],
        "status": "official-series-summary"
      },
      "sources": [
        "k1_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "k1-numeric:2560",
      "namespace": "k1-numeric",
      "catalogs": [
        "k1-numeric"
      ],
      "canonicalCode": "2560",
      "numericCode": 2560,
      "prefix": null,
      "subsystem": "legacy-k1",
      "messageJa": "メインMCU通信が異常です。",
      "transportRole": "legacy-key",
      "applicability": {
        "models": [
          "K1 series"
        ],
        "k1": "yes",
        "k2": "no-as-k1-numeric-namespace",
        "features": [],
        "status": "official-series-summary"
      },
      "sources": [
        "k1_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "k1-numeric:2561",
      "namespace": "k1-numeric",
      "catalogs": [
        "k1-numeric"
      ],
      "canonicalCode": "2561",
      "numericCode": 2561,
      "prefix": null,
      "subsystem": "legacy-k1",
      "messageJa": "ホットエンドMCU通信が異常です。",
      "transportRole": "legacy-key",
      "applicability": {
        "models": [
          "K1 series"
        ],
        "k1": "yes",
        "k2": "no-as-k1-numeric-namespace",
        "features": [],
        "status": "official-series-summary"
      },
      "sources": [
        "k1_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "k1-numeric:2562",
      "namespace": "k1-numeric",
      "catalogs": [
        "k1-numeric"
      ],
      "canonicalCode": "2562",
      "numericCode": 2562,
      "prefix": null,
      "subsystem": "legacy-k1",
      "messageJa": "ヒートベッドMCU通信が異常です。",
      "transportRole": "legacy-key",
      "applicability": {
        "models": [
          "K1 series"
        ],
        "k1": "yes",
        "k2": "no-as-k1-numeric-namespace",
        "features": [],
        "status": "official-series-summary"
      },
      "sources": [
        "k1_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "k1-numeric:2563",
      "namespace": "k1-numeric",
      "catalogs": [
        "k1-numeric"
      ],
      "canonicalCode": "2563",
      "numericCode": 2563,
      "prefix": null,
      "subsystem": "legacy-k1",
      "messageJa": "RPi MCU通信が異常です。",
      "transportRole": "legacy-key",
      "applicability": {
        "models": [
          "K1 series"
        ],
        "k1": "yes",
        "k2": "no-as-k1-numeric-namespace",
        "features": [],
        "status": "official-series-summary"
      },
      "sources": [
        "k1_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "k1-numeric:2564",
      "namespace": "k1-numeric",
      "catalogs": [
        "k1-numeric"
      ],
      "canonicalCode": "2564",
      "numericCode": 2564,
      "prefix": null,
      "subsystem": "legacy-k1",
      "messageJa": "ノズルが期待どおりに加熱されません。",
      "transportRole": "legacy-key",
      "applicability": {
        "models": [
          "K1 series"
        ],
        "k1": "yes",
        "k2": "no-as-k1-numeric-namespace",
        "features": [],
        "status": "official-series-summary"
      },
      "sources": [
        "k1_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "k1-numeric:2565",
      "namespace": "k1-numeric",
      "catalogs": [
        "k1-numeric"
      ],
      "canonicalCode": "2565",
      "numericCode": 2565,
      "prefix": null,
      "subsystem": "legacy-k1",
      "messageJa": "ヒートベッドが期待どおりに加熱されません。",
      "transportRole": "legacy-key",
      "applicability": {
        "models": [
          "K1 series"
        ],
        "k1": "yes",
        "k2": "no-as-k1-numeric-namespace",
        "features": [],
        "status": "official-series-summary"
      },
      "sources": [
        "k1_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "k1-numeric:3002",
      "namespace": "k1-numeric",
      "catalogs": [
        "k1-numeric"
      ],
      "canonicalCode": "3002",
      "numericCode": 3002,
      "prefix": null,
      "subsystem": "legacy-k1",
      "messageJa": "ホットエンド／ノズル通信が異常です。端子・ケーブル・ファームウェア整合性を確認してください。",
      "transportRole": "legacy-key",
      "applicability": {
        "models": [
          "K1 series"
        ],
        "k1": "yes",
        "k2": "no-as-k1-numeric-namespace",
        "features": [],
        "status": "official-series-summary"
      },
      "sources": [
        "k1_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "k1-numeric:2507",
      "namespace": "k1-numeric",
      "catalogs": [
        "k1-numeric",
        "historical-supplement"
      ],
      "canonicalCode": "2507",
      "numericCode": 2507,
      "prefix": null,
      "subsystem": "legacy-k1",
      "messageJa": "旧ファームウェアで使用された『期待どおりに加熱されない』エラー。1.3.1.x以降は主に2564/2565へ分離。",
      "transportRole": "legacy-key",
      "applicability": {
        "models": [
          "K1 series"
        ],
        "k1": "yes",
        "k2": "no-as-k1-numeric-namespace",
        "features": [],
        "status": "official-troubleshooting-supplement"
      },
      "sources": [
        "k1_general_docs"
      ],
      "confidence": "high",
      "notes": [
        "補助/履歴エントリ。現行サマリー表だけではなく公式トラブルシュート索引から保持。"
      ]
    },
    {
      "id": "k1-numeric:2571",
      "namespace": "k1-numeric",
      "catalogs": [
        "k1-numeric",
        "historical-supplement"
      ],
      "canonicalCode": "2571",
      "numericCode": 2571,
      "prefix": null,
      "subsystem": "legacy-k1",
      "messageJa": "G-codeファイルの文字エンコーディング／解析に問題があります。",
      "transportRole": "legacy-key",
      "applicability": {
        "models": [
          "K1 series"
        ],
        "k1": "yes",
        "k2": "no-as-k1-numeric-namespace",
        "features": [],
        "status": "official-troubleshooting-supplement"
      },
      "sources": [
        "k1_general_docs"
      ],
      "confidence": "high",
      "notes": [
        "補助/履歴エントリ。現行サマリー表だけではなく公式トラブルシュート索引から保持。"
      ]
    },
    {
      "id": "creality-os:AC0101",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os"
      ],
      "canonicalCode": "AC0101",
      "numericCode": 101,
      "prefix": "AC",
      "subsystem": "AI/camera",
      "messageJa": "AIが印刷品質異常を検出し、印刷を一時停止しました。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "unknown",
        "features": [],
        "status": "global-index-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index"
      ],
      "confidence": "medium-high",
      "notes": []
    },
    {
      "id": "creality-os:AC0103",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os"
      ],
      "canonicalCode": "AC0103",
      "numericCode": 103,
      "prefix": "AC",
      "subsystem": "AI/camera",
      "messageJa": "AIが初層品質異常を検出し、印刷を一時停止しました。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "unknown",
        "features": [],
        "status": "global-index-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index"
      ],
      "confidence": "medium-high",
      "notes": []
    },
    {
      "id": "creality-os:AC0104",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os"
      ],
      "canonicalCode": "AC0104",
      "numericCode": 104,
      "prefix": "AC",
      "subsystem": "AI/camera",
      "messageJa": "印刷プレート上の異物を検出し、印刷を一時停止しました。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "unknown",
        "features": [],
        "status": "global-index-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index"
      ],
      "confidence": "medium-high",
      "notes": []
    },
    {
      "id": "creality-os:AC0117",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os"
      ],
      "canonicalCode": "AC0117",
      "numericCode": 117,
      "prefix": "AC",
      "subsystem": "AI/camera",
      "messageJa": "反りを検出し、印刷を一時停止しました。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "unknown",
        "features": [],
        "status": "global-index-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index"
      ],
      "confidence": "medium-high",
      "notes": []
    },
    {
      "id": "creality-os:AC0119",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os"
      ],
      "canonicalCode": "AC0119",
      "numericCode": 119,
      "prefix": "AC",
      "subsystem": "AI/camera",
      "messageJa": "廃棄物シュートが塞がれている可能性があります。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "unknown",
        "features": [],
        "status": "global-index-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index"
      ],
      "confidence": "medium-high",
      "notes": []
    },
    {
      "id": "creality-os:AC0123",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os"
      ],
      "canonicalCode": "AC0123",
      "numericCode": 123,
      "prefix": "AC",
      "subsystem": "AI/camera",
      "messageJa": "印刷プレートが見つからず、印刷を一時停止しました。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "unknown",
        "features": [],
        "status": "global-index-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index"
      ],
      "confidence": "medium-high",
      "notes": []
    },
    {
      "id": "creality-os:AC0124",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os"
      ],
      "canonicalCode": "AC0124",
      "numericCode": 124,
      "prefix": "AC",
      "subsystem": "AI/camera",
      "messageJa": "印刷プレート未検出または異物検出により一時停止しました。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "unknown",
        "features": [],
        "status": "global-index-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index"
      ],
      "confidence": "medium-high",
      "notes": []
    },
    {
      "id": "creality-os:AC0500",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os"
      ],
      "canonicalCode": "AC0500",
      "numericCode": 500,
      "prefix": "AC",
      "subsystem": "AI/camera",
      "messageJa": "AIが印刷品質の問題を検出しました。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [
          "K1C",
          "K1 Max",
          "K2 Plus"
        ],
        "k1": "yes",
        "k2": "yes",
        "features": [],
        "status": "verified-individual-page"
      },
      "sources": [
        "creality_os_index",
        "ac0500"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "creality-os:AC0503",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os"
      ],
      "canonicalCode": "AC0503",
      "numericCode": 503,
      "prefix": "AC",
      "subsystem": "AI/camera",
      "messageJa": "初層品質の問題を検出しました。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "unknown",
        "features": [],
        "status": "global-index-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index"
      ],
      "confidence": "medium-high",
      "notes": []
    },
    {
      "id": "creality-os:AC0504",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os"
      ],
      "canonicalCode": "AC0504",
      "numericCode": 504,
      "prefix": "AC",
      "subsystem": "AI/camera",
      "messageJa": "現在のファイルは自動PA校正に対応していません。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "unknown",
        "features": [],
        "status": "global-index-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index"
      ],
      "confidence": "medium-high",
      "notes": []
    },
    {
      "id": "creality-os:AC0509",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os"
      ],
      "canonicalCode": "AC0509",
      "numericCode": 509,
      "prefix": "AC",
      "subsystem": "AI/camera",
      "messageJa": "チャンバー温度が高すぎるため、カメラを停止しています。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "unknown",
        "features": [],
        "status": "global-index-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index"
      ],
      "confidence": "medium-high",
      "notes": []
    },
    {
      "id": "creality-os:AC0510",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os"
      ],
      "canonicalCode": "AC0510",
      "numericCode": 510,
      "prefix": "AC",
      "subsystem": "AI/camera",
      "messageJa": "カメラを起動できません。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "unknown",
        "features": [],
        "status": "global-index-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index"
      ],
      "confidence": "medium-high",
      "notes": []
    },
    {
      "id": "creality-os:AC0511",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os"
      ],
      "canonicalCode": "AC0511",
      "numericCode": 511,
      "prefix": "AC",
      "subsystem": "AI/camera",
      "messageJa": "現在のファイルはフロー比校正に対応していません。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "unknown",
        "features": [],
        "status": "global-index-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index"
      ],
      "confidence": "medium-high",
      "notes": []
    },
    {
      "id": "creality-os:AC0512",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os"
      ],
      "canonicalCode": "AC0512",
      "numericCode": 512,
      "prefix": "AC",
      "subsystem": "AI/camera",
      "messageJa": "フロー比校正を実行できません／対象材料を確認してください。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "unknown",
        "features": [],
        "status": "global-index-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index"
      ],
      "confidence": "medium-high",
      "notes": []
    },
    {
      "id": "creality-os:AC0513",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os"
      ],
      "canonicalCode": "AC0513",
      "numericCode": 513,
      "prefix": "AC",
      "subsystem": "AI/camera",
      "messageJa": "自動PA校正用画像が異常です。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "unknown",
        "features": [],
        "status": "global-index-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index"
      ],
      "confidence": "medium-high",
      "notes": []
    },
    {
      "id": "creality-os:AC0514",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os"
      ],
      "canonicalCode": "AC0514",
      "numericCode": 514,
      "prefix": "AC",
      "subsystem": "AI/camera",
      "messageJa": "自動PA校正に失敗しました。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "unknown",
        "features": [],
        "status": "global-index-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index"
      ],
      "confidence": "medium-high",
      "notes": []
    },
    {
      "id": "creality-os:AC0515",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os"
      ],
      "canonicalCode": "AC0515",
      "numericCode": 515,
      "prefix": "AC",
      "subsystem": "AI/camera",
      "messageJa": "フロー比校正用画像が異常です。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "unknown",
        "features": [],
        "status": "global-index-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index"
      ],
      "confidence": "medium-high",
      "notes": []
    },
    {
      "id": "creality-os:AC0516",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os"
      ],
      "canonicalCode": "AC0516",
      "numericCode": 516,
      "prefix": "AC",
      "subsystem": "AI/camera",
      "messageJa": "フロー比校正に失敗しました。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "unknown",
        "features": [],
        "status": "global-index-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index"
      ],
      "confidence": "medium-high",
      "notes": []
    },
    {
      "id": "creality-os:AC0523",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os"
      ],
      "canonicalCode": "AC0523",
      "numericCode": 523,
      "prefix": "AC",
      "subsystem": "AI/camera",
      "messageJa": "モデルの反りを検出しました。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "unknown",
        "features": [],
        "status": "global-index-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index"
      ],
      "confidence": "medium-high",
      "notes": []
    },
    {
      "id": "creality-os:AC0527",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os"
      ],
      "canonicalCode": "AC0527",
      "numericCode": 527,
      "prefix": "AC",
      "subsystem": "AI/camera",
      "messageJa": "廃棄物シュートが塞がれている可能性があります。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "unknown",
        "features": [],
        "status": "global-index-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index"
      ],
      "confidence": "medium-high",
      "notes": []
    },
    {
      "id": "creality-os:AL0505",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os"
      ],
      "canonicalCode": "AL0505",
      "numericCode": 505,
      "prefix": "AL",
      "subsystem": "AI/LiDAR",
      "messageJa": "AI LiDARが異常です。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "unknown",
        "features": [],
        "status": "global-index-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index"
      ],
      "confidence": "medium-high",
      "notes": []
    },
    {
      "id": "creality-os:AL0506",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os"
      ],
      "canonicalCode": "AL0506",
      "numericCode": 506,
      "prefix": "AL",
      "subsystem": "AI/LiDAR",
      "messageJa": "AI LiDARのキャリブレーションに失敗しました。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "unknown",
        "features": [],
        "status": "global-index-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index"
      ],
      "confidence": "medium-high",
      "notes": []
    },
    {
      "id": "creality-os:AL0507",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os"
      ],
      "canonicalCode": "AL0507",
      "numericCode": 507,
      "prefix": "AL",
      "subsystem": "AI/LiDAR",
      "messageJa": "AI LiDARの位置合わせに失敗しました。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "unknown",
        "features": [],
        "status": "global-index-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index"
      ],
      "confidence": "medium-high",
      "notes": []
    },
    {
      "id": "creality-os:BM0110",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os"
      ],
      "canonicalCode": "BM0110",
      "numericCode": 110,
      "prefix": "BM",
      "subsystem": "board/connection",
      "messageJa": "メインボードとの接続に失敗しました。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "unknown",
        "features": [],
        "status": "global-index-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index"
      ],
      "confidence": "medium-high",
      "notes": []
    },
    {
      "id": "creality-os:BM0111",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os"
      ],
      "canonicalCode": "BM0111",
      "numericCode": 111,
      "prefix": "BM",
      "subsystem": "board/connection",
      "messageJa": "ホットエンドとの接続が異常です。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [
          "K1 series",
          "V3 series",
          "K2 series",
          "Creality Hi"
        ],
        "k1": "yes",
        "k2": "yes",
        "features": [],
        "status": "verified-individual-page"
      },
      "sources": [
        "creality_os_index",
        "individual_bm0111"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "creality-os:BM0112",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os"
      ],
      "canonicalCode": "BM0112",
      "numericCode": 112,
      "prefix": "BM",
      "subsystem": "board/connection",
      "messageJa": "ヒートベッドとの接続が異常です。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "unknown",
        "features": [],
        "status": "global-index-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index"
      ],
      "confidence": "medium-high",
      "notes": []
    },
    {
      "id": "creality-os:BM2512",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os"
      ],
      "canonicalCode": "BM2512",
      "numericCode": 2512,
      "prefix": "BM",
      "subsystem": "board/connection",
      "messageJa": "メインボード温度が異常です。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "unknown",
        "features": [],
        "status": "global-index-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index"
      ],
      "confidence": "medium-high",
      "notes": []
    },
    {
      "id": "creality-os:BS0508",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os"
      ],
      "canonicalCode": "BS0508",
      "numericCode": 508,
      "prefix": "BS",
      "subsystem": "board/storage",
      "messageJa": "ストレージ使用量がしきい値に達しました。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [
          "K1C",
          "K1 Max",
          "K2 series",
          "Creality Hi"
        ],
        "k1": "yes",
        "k2": "yes",
        "features": [],
        "status": "verified-individual-page"
      },
      "sources": [
        "creality_os_index",
        "individual_bs0508"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "creality-os:CA0120",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os"
      ],
      "canonicalCode": "CA0120",
      "numericCode": 120,
      "prefix": "CA",
      "subsystem": "controller/belt",
      "messageJa": "ベルト張力が異常です。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "unknown",
        "features": [],
        "status": "global-index-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index"
      ],
      "confidence": "medium-high",
      "notes": []
    },
    {
      "id": "creality-os:CA2710",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os"
      ],
      "canonicalCode": "CA2710",
      "numericCode": 2710,
      "prefix": "CA",
      "subsystem": "controller/belt",
      "messageJa": "ベルト張力モジュールが異常です。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "unknown",
        "features": [],
        "status": "global-index-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index"
      ],
      "confidence": "medium-high",
      "notes": []
    },
    {
      "id": "creality-os:CA2711",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os"
      ],
      "canonicalCode": "CA2711",
      "numericCode": 2711,
      "prefix": "CA",
      "subsystem": "controller/belt",
      "messageJa": "自動ベルト張力調整に失敗しました。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "unknown",
        "features": [],
        "status": "global-index-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index"
      ],
      "confidence": "medium-high",
      "notes": []
    },
    {
      "id": "creality-os:CA2720",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os"
      ],
      "canonicalCode": "CA2720",
      "numericCode": 2720,
      "prefix": "CA",
      "subsystem": "controller/belt",
      "messageJa": "右ベルト張力モジュールの校正が異常です。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "unknown",
        "features": [],
        "status": "global-index-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index"
      ],
      "confidence": "medium-high",
      "notes": []
    },
    {
      "id": "creality-os:CA2721",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os"
      ],
      "canonicalCode": "CA2721",
      "numericCode": 2721,
      "prefix": "CA",
      "subsystem": "controller/belt",
      "messageJa": "左ベルト張力モジュールの校正が異常です。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "unknown",
        "features": [],
        "status": "global-index-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index"
      ],
      "confidence": "medium-high",
      "notes": []
    },
    {
      "id": "creality-os:CB2510",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os"
      ],
      "canonicalCode": "CB2510",
      "numericCode": 2510,
      "prefix": "CB",
      "subsystem": "controller/bed",
      "messageJa": "ベッドサーミスタが断線している可能性があります。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [
          "K1 series",
          "V3 series",
          "K2 series",
          "Creality Hi"
        ],
        "k1": "yes",
        "k2": "yes",
        "features": [],
        "status": "verified-individual-page"
      },
      "sources": [
        "creality_os_index",
        "individual_cb2510"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "creality-os:CB2516",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os"
      ],
      "canonicalCode": "CB2516",
      "numericCode": 2516,
      "prefix": "CB",
      "subsystem": "controller/bed",
      "messageJa": "ベッドサーミスタが短絡している可能性があります。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "unknown",
        "features": [],
        "status": "global-index-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index"
      ],
      "confidence": "medium-high",
      "notes": []
    },
    {
      "id": "creality-os:CB2565",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os"
      ],
      "canonicalCode": "CB2565",
      "numericCode": 2565,
      "prefix": "CB",
      "subsystem": "controller/bed",
      "messageJa": "ベッドが期待どおりに加熱されません。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "unknown",
        "features": [],
        "status": "global-index-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index"
      ],
      "confidence": "medium-high",
      "notes": []
    },
    {
      "id": "creality-os:CF0109",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os"
      ],
      "canonicalCode": "CF0109",
      "numericCode": 109,
      "prefix": "CF",
      "subsystem": "controller/fan",
      "messageJa": "ファンのフィードバックが異常です。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [
          "K1 series",
          "K2 series"
        ],
        "k1": "yes",
        "k2": "yes",
        "features": [],
        "status": "verified-individual-page"
      },
      "sources": [
        "creality_os_index",
        "individual_cf0109"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "creality-os:CF0502",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os"
      ],
      "canonicalCode": "CF0502",
      "numericCode": 502,
      "prefix": "CF",
      "subsystem": "controller/fan",
      "messageJa": "メインボードファンが異常です。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "unknown",
        "features": [],
        "status": "global-index-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index"
      ],
      "confidence": "medium-high",
      "notes": []
    },
    {
      "id": "creality-os:CL2536",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os"
      ],
      "canonicalCode": "CL2536",
      "numericCode": 2536,
      "prefix": "CL",
      "subsystem": "controller/leveling",
      "messageJa": "レベリングセンサーのハードウェアが故障しています。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [
          "K1 series",
          "V3 series",
          "K2 series",
          "Creality Hi"
        ],
        "k1": "yes",
        "k2": "yes",
        "features": [],
        "status": "verified-individual-page"
      },
      "sources": [
        "creality_os_index",
        "individual_cl2536"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "creality-os:CL2537",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os"
      ],
      "canonicalCode": "CL2537",
      "numericCode": 2537,
      "prefix": "CL",
      "subsystem": "controller/leveling",
      "messageJa": "レベリングセンサーが外乱を受けています。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "unknown",
        "features": [],
        "status": "global-index-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index"
      ],
      "confidence": "medium-high",
      "notes": []
    },
    {
      "id": "creality-os:CM0115",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os"
      ],
      "canonicalCode": "CM0115",
      "numericCode": 115,
      "prefix": "CM",
      "subsystem": "controller/motion",
      "messageJa": "未完了の印刷タスクを検出しました。停電復旧候補です。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [
          "K1 series",
          "V3 series",
          "K2 series",
          "Creality Hi",
          "i7"
        ],
        "k1": "yes",
        "k2": "yes",
        "features": [],
        "status": "verified-individual-page"
      },
      "sources": [
        "creality_os_index",
        "individual_cm0115"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "creality-os:CM2781",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os"
      ],
      "canonicalCode": "CM2781",
      "numericCode": 2781,
      "prefix": "CM",
      "subsystem": "controller/motion",
      "messageJa": "モーター速度上限を超えました。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "unknown",
        "features": [],
        "status": "global-index-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index"
      ],
      "confidence": "medium-high",
      "notes": []
    },
    {
      "id": "creality-os:CM2782",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os"
      ],
      "canonicalCode": "CM2782",
      "numericCode": 2782,
      "prefix": "CM",
      "subsystem": "controller/motion",
      "messageJa": "ステップサーボのハードウェアが異常です。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "unknown",
        "features": [],
        "status": "global-index-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index"
      ],
      "confidence": "medium-high",
      "notes": []
    },
    {
      "id": "creality-os:CM2783",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os"
      ],
      "canonicalCode": "CM2783",
      "numericCode": 2783,
      "prefix": "CM",
      "subsystem": "controller/motion",
      "messageJa": "移動方向の抵抗が異常です。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "unknown",
        "features": [],
        "status": "global-index-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index"
      ],
      "confidence": "medium-high",
      "notes": []
    },
    {
      "id": "creality-os:CM2784",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os"
      ],
      "canonicalCode": "CM2784",
      "numericCode": 2784,
      "prefix": "CM",
      "subsystem": "controller/motion",
      "messageJa": "移動方向の抵抗が異常です。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "unknown",
        "features": [],
        "status": "global-index-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index"
      ],
      "confidence": "medium-high",
      "notes": []
    },
    {
      "id": "creality-os:CM2785",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os"
      ],
      "canonicalCode": "CM2785",
      "numericCode": 2785,
      "prefix": "CM",
      "subsystem": "controller/motion",
      "messageJa": "移動方向の抵抗が異常です。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "unknown",
        "features": [],
        "status": "global-index-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index"
      ],
      "confidence": "medium-high",
      "notes": []
    },
    {
      "id": "creality-os:CM2786",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os"
      ],
      "canonicalCode": "CM2786",
      "numericCode": 2786,
      "prefix": "CM",
      "subsystem": "controller/motion",
      "messageJa": "モーター速度上限を超えました。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "unknown",
        "features": [],
        "status": "global-index-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index"
      ],
      "confidence": "medium-high",
      "notes": []
    },
    {
      "id": "creality-os:CM2789",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os"
      ],
      "canonicalCode": "CM2789",
      "numericCode": 2789,
      "prefix": "CM",
      "subsystem": "controller/motion",
      "messageJa": "移動抵抗が異常です。衝突や機械的干渉を確認してください。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "unknown",
        "features": [],
        "status": "global-index-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index"
      ],
      "confidence": "medium-high",
      "notes": []
    },
    {
      "id": "creality-os:CM2790",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os"
      ],
      "canonicalCode": "CM2790",
      "numericCode": 2790,
      "prefix": "CM",
      "subsystem": "controller/motion",
      "messageJa": "モーター識別エラーです。モーター／配線を確認してください。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "unknown",
        "features": [],
        "status": "global-index-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index"
      ],
      "confidence": "medium-high",
      "notes": []
    },
    {
      "id": "creality-os:CM2798",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os"
      ],
      "canonicalCode": "CM2798",
      "numericCode": 2798,
      "prefix": "CM",
      "subsystem": "controller/motion",
      "messageJa": "ステップサーボ初期化エラーです。通信ケーブルを確認してください。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "unknown",
        "features": [],
        "status": "global-index-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index"
      ],
      "confidence": "medium-high",
      "notes": []
    },
    {
      "id": "creality-os:CT2511",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os"
      ],
      "canonicalCode": "CT2511",
      "numericCode": 2511,
      "prefix": "CT",
      "subsystem": "controller/chamber-temp",
      "messageJa": "チャンバーサーミスタが断線している可能性があります。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "unknown",
        "features": [],
        "status": "global-index-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index"
      ],
      "confidence": "medium-high",
      "notes": []
    },
    {
      "id": "creality-os:CT2517",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os"
      ],
      "canonicalCode": "CT2517",
      "numericCode": 2517,
      "prefix": "CT",
      "subsystem": "controller/chamber-temp",
      "messageJa": "チャンバーサーミスタが短絡している可能性があります。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "unknown",
        "features": [],
        "status": "global-index-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index"
      ],
      "confidence": "medium-high",
      "notes": []
    },
    {
      "id": "creality-os:CX2566",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os"
      ],
      "canonicalCode": "CX2566",
      "numericCode": 2566,
      "prefix": "CX",
      "subsystem": "controller/X",
      "messageJa": "X軸モータードライバが異常です。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "unknown",
        "features": [],
        "status": "global-index-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index"
      ],
      "confidence": "medium-high",
      "notes": []
    },
    {
      "id": "creality-os:CX2573",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os"
      ],
      "canonicalCode": "CX2573",
      "numericCode": 2573,
      "prefix": "CX",
      "subsystem": "controller/X",
      "messageJa": "X軸原点復帰が異常です。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [
          "K1 series",
          "V3 series",
          "K2 series",
          "Creality Hi",
          "i7"
        ],
        "k1": "yes",
        "k2": "yes",
        "features": [],
        "status": "verified-individual-page"
      },
      "sources": [
        "creality_os_index",
        "individual_cx2573"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "creality-os:CX2585",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os"
      ],
      "canonicalCode": "CX2585",
      "numericCode": 2585,
      "prefix": "CX",
      "subsystem": "controller/X",
      "messageJa": "X軸印刷座標が範囲外です。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [
          "K1 series",
          "V3 series",
          "K2 series",
          "Creality Hi"
        ],
        "k1": "yes",
        "k2": "yes",
        "features": [],
        "status": "verified-individual-page"
      },
      "sources": [
        "creality_os_index",
        "individual_cx2585"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "creality-os:CY2567",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os"
      ],
      "canonicalCode": "CY2567",
      "numericCode": 2567,
      "prefix": "CY",
      "subsystem": "controller/Y",
      "messageJa": "Y軸モータードライバが異常です。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "unknown",
        "features": [],
        "status": "global-index-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index"
      ],
      "confidence": "medium-high",
      "notes": []
    },
    {
      "id": "creality-os:CY2577",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os"
      ],
      "canonicalCode": "CY2577",
      "numericCode": 2577,
      "prefix": "CY",
      "subsystem": "controller/Y",
      "messageJa": "Y軸原点復帰が異常です。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [
          "K1 series",
          "V3 series",
          "K2 series",
          "Creality Hi",
          "i7"
        ],
        "k1": "yes",
        "k2": "yes",
        "features": [],
        "status": "verified-individual-page"
      },
      "sources": [
        "creality_os_index",
        "individual_cy2577"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "creality-os:CY2586",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os"
      ],
      "canonicalCode": "CY2586",
      "numericCode": 2586,
      "prefix": "CY",
      "subsystem": "controller/Y",
      "messageJa": "Y軸印刷座標が範囲外です。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [
          "K1 series",
          "V3 series",
          "K2 series",
          "Creality Hi"
        ],
        "k1": "yes",
        "k2": "yes",
        "features": [],
        "status": "verified-individual-page"
      },
      "sources": [
        "creality_os_index",
        "individual_cy2586"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "creality-os:CZ2352",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os"
      ],
      "canonicalCode": "CZ2352",
      "numericCode": 2352,
      "prefix": "CZ",
      "subsystem": "controller/Z",
      "messageJa": "ヒートベッドがZ最大位置へ復帰できない、または傾き校正に失敗しました。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "unknown",
        "features": [],
        "status": "global-index-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index"
      ],
      "confidence": "medium-high",
      "notes": []
    },
    {
      "id": "creality-os:CZ2568",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os"
      ],
      "canonicalCode": "CZ2568",
      "numericCode": 2568,
      "prefix": "CZ",
      "subsystem": "controller/Z",
      "messageJa": "Z軸モータードライバが異常です。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "unknown",
        "features": [],
        "status": "global-index-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index"
      ],
      "confidence": "medium-high",
      "notes": []
    },
    {
      "id": "creality-os:CZ2581",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os"
      ],
      "canonicalCode": "CZ2581",
      "numericCode": 2581,
      "prefix": "CZ",
      "subsystem": "controller/Z",
      "messageJa": "Z軸原点復帰が異常です。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "unknown",
        "features": [],
        "status": "global-index-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index"
      ],
      "confidence": "medium-high",
      "notes": []
    },
    {
      "id": "creality-os:CZ2587",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os"
      ],
      "canonicalCode": "CZ2587",
      "numericCode": 2587,
      "prefix": "CZ",
      "subsystem": "controller/Z",
      "messageJa": "Z軸印刷座標が範囲外です。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [
          "K1 series",
          "V3 series",
          "K2 series",
          "Creality Hi"
        ],
        "k1": "yes",
        "k2": "yes",
        "features": [],
        "status": "verified-individual-page"
      },
      "sources": [
        "creality_os_index",
        "individual_cz2587"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "creality-os:CZ2588",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os"
      ],
      "canonicalCode": "CZ2588",
      "numericCode": 2588,
      "prefix": "CZ",
      "subsystem": "controller/Z",
      "messageJa": "Zオフセットが許容範囲を超えています。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "unknown",
        "features": [],
        "status": "global-index-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index"
      ],
      "confidence": "medium-high",
      "notes": []
    },
    {
      "id": "creality-os:CZ2768",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os"
      ],
      "canonicalCode": "CZ2768",
      "numericCode": 2768,
      "prefix": "CZ",
      "subsystem": "controller/Z",
      "messageJa": "Z軸原点復帰が異常です。外乱を確認してください。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "unknown",
        "features": [],
        "status": "global-index-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index"
      ],
      "confidence": "medium-high",
      "notes": []
    },
    {
      "id": "creality-os:FB2844",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os",
        "cfs"
      ],
      "canonicalCode": "FB2844",
      "numericCode": 2844,
      "prefix": "FB",
      "subsystem": "CFS/buffer",
      "messageJa": "PTFEチューブが継手から外れた可能性があります。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "feature-dependent",
        "features": [
          "cfs"
        ],
        "status": "cfs-summary-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index",
        "cfs_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "creality-os:FB2846",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os",
        "cfs"
      ],
      "canonicalCode": "FB2846",
      "numericCode": 2846,
      "prefix": "FB",
      "subsystem": "CFS/buffer",
      "messageJa": "フィラメントバッファ信号が異常です。バッファ固着や絡まりを確認してください。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "feature-dependent",
        "features": [
          "cfs"
        ],
        "status": "cfs-summary-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index",
        "cfs_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "creality-os:FB2847",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os",
        "cfs"
      ],
      "canonicalCode": "FB2847",
      "numericCode": 2847,
      "prefix": "FB",
      "subsystem": "CFS/buffer",
      "messageJa": "フィラメントが絡まっている可能性があります。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "feature-dependent",
        "features": [
          "cfs"
        ],
        "status": "cfs-summary-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index",
        "cfs_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "creality-os:FB2860",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os",
        "cfs"
      ],
      "canonicalCode": "FB2860",
      "numericCode": 2860,
      "prefix": "FB",
      "subsystem": "CFS/buffer",
      "messageJa": "CFSフィラメントバッファが異常です。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "feature-dependent",
        "features": [
          "cfs"
        ],
        "status": "cfs-summary-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index",
        "cfs_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "creality-os:FB2864",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os",
        "cfs"
      ],
      "canonicalCode": "FB2864",
      "numericCode": 2864,
      "prefix": "FB",
      "subsystem": "CFS/buffer",
      "messageJa": "フィラメント送り異常です。バッファ故障を確認してください。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "feature-dependent",
        "features": [
          "cfs"
        ],
        "status": "cfs-summary-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index",
        "cfs_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "creality-os:FH2853",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os",
        "cfs"
      ],
      "canonicalCode": "FH2853",
      "numericCode": 2853,
      "prefix": "FH",
      "subsystem": "CFS/temp-humidity",
      "messageJa": "CFS温湿度センサーが異常です。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "feature-dependent",
        "features": [
          "cfs"
        ],
        "status": "cfs-summary-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index",
        "cfs_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "creality-os:FM2857",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os",
        "cfs"
      ],
      "canonicalCode": "FM2857",
      "numericCode": 2857,
      "prefix": "FM",
      "subsystem": "CFS/motor",
      "messageJa": "CFS送りモーターが過負荷です。経路抵抗・絡まり・詰まりを確認してください。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "feature-dependent",
        "features": [
          "cfs"
        ],
        "status": "cfs-summary-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index",
        "cfs_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "creality-os:FO0528",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os",
        "cfs"
      ],
      "canonicalCode": "FO0528",
      "numericCode": 528,
      "prefix": "FO",
      "subsystem": "CFS/odometer-extrusion",
      "messageJa": "印刷動作中ですが、実際にはフィラメントが押し出されていない可能性があります。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [
          "K2 Plus",
          "K2 Pro",
          "K2",
          "Creality Hi"
        ],
        "k1": "unknown",
        "k2": "yes",
        "features": [
          "cfs"
        ],
        "status": "verified-individual-page"
      },
      "sources": [
        "creality_os_index",
        "cfs_official_summary",
        "fo0528"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "creality-os:FO2837",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os",
        "cfs"
      ],
      "canonicalCode": "FO2837",
      "numericCode": 2837,
      "prefix": "FO",
      "subsystem": "CFS/odometer-extrusion",
      "messageJa": "押出機センサーから押出ギア間でフィラメントが詰まっている可能性があります。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "feature-dependent",
        "features": [
          "cfs"
        ],
        "status": "cfs-summary-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index",
        "cfs_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "creality-os:FO2838",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os",
        "cfs"
      ],
      "canonicalCode": "FO2838",
      "numericCode": 2838,
      "prefix": "FO",
      "subsystem": "CFS/odometer-extrusion",
      "messageJa": "CFSハブセンサーからギア間でフィラメントが詰まっている可能性があります。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "feature-dependent",
        "features": [
          "cfs"
        ],
        "status": "cfs-summary-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index",
        "cfs_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "creality-os:FO2845",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os",
        "cfs"
      ],
      "canonicalCode": "FO2845",
      "numericCode": 2845,
      "prefix": "FO",
      "subsystem": "CFS/odometer-extrusion",
      "messageJa": "押出機が詰まっている可能性があります。フィラメント経路と押出機を確認してください。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "feature-dependent",
        "features": [
          "cfs"
        ],
        "status": "cfs-summary-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index",
        "cfs_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "creality-os:FO2859",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os",
        "cfs"
      ],
      "canonicalCode": "FO2859",
      "numericCode": 2859,
      "prefix": "FO",
      "subsystem": "CFS/odometer-extrusion",
      "messageJa": "CFSのフィラメント距離計測（オドメータ）が異常です。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [
          "K2 Plus",
          "K2 Pro",
          "K2",
          "Creality Hi"
        ],
        "k1": "unknown",
        "k2": "yes",
        "features": [
          "cfs"
        ],
        "status": "verified-individual-page"
      },
      "sources": [
        "creality_os_index",
        "cfs_official_summary",
        "fo2859"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "creality-os:FO2936",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os",
        "cfs"
      ],
      "canonicalCode": "FO2936",
      "numericCode": 2936,
      "prefix": "FO",
      "subsystem": "CFS/odometer-extrusion",
      "messageJa": "フィラメントセンサーから押出ギア間の送り異常です。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [
          "SPARKX i7"
        ],
        "k1": "no",
        "k2": "no",
        "features": [
          "cfs"
        ],
        "status": "verified-non-k1-k2"
      },
      "sources": [
        "creality_os_index"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "creality-os:FO5008",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os",
        "cfs"
      ],
      "canonicalCode": "FO5008",
      "numericCode": 5008,
      "prefix": "FO",
      "subsystem": "CFS/odometer-extrusion",
      "messageJa": "押出機が詰まっている可能性があります。詰まりを解消して再試行してください。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "feature-dependent",
        "k2": "feature-dependent",
        "features": [
          "cfs"
        ],
        "status": "global-index-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index"
      ],
      "confidence": "medium-high",
      "notes": []
    },
    {
      "id": "creality-os:FR0121",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os",
        "cfs"
      ],
      "canonicalCode": "FR0121",
      "numericCode": 121,
      "prefix": "FR",
      "subsystem": "CFS/feed-retract",
      "messageJa": "CFSフィラメント使用中です。外部スプールへ切り替える前にCFS側をアンロードしてください。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "feature-dependent",
        "features": [
          "cfs"
        ],
        "status": "cfs-summary-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index",
        "cfs_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "creality-os:FR0122",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os",
        "cfs"
      ],
      "canonicalCode": "FR0122",
      "numericCode": 122,
      "prefix": "FR",
      "subsystem": "CFS/feed-retract",
      "messageJa": "外部スプールのフィラメント使用中です。CFSへ切り替える前に外部側をアンロードしてください。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [
          "K2 Plus",
          "K2 Pro",
          "K2",
          "Creality Hi",
          "i7"
        ],
        "k1": "unknown",
        "k2": "yes",
        "features": [
          "cfs"
        ],
        "status": "verified-individual-page"
      },
      "sources": [
        "creality_os_index",
        "cfs_official_summary",
        "fr0122"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "creality-os:FR2832",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os",
        "cfs"
      ],
      "canonicalCode": "FR2832",
      "numericCode": 2832,
      "prefix": "FR",
      "subsystem": "CFS/feed-retract",
      "messageJa": "フィラメントのリトラクト異常です。絡まりや詰まりを確認してください。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "feature-dependent",
        "features": [
          "cfs"
        ],
        "status": "cfs-summary-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index",
        "cfs_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "creality-os:FR2833",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os",
        "cfs"
      ],
      "canonicalCode": "FR2833",
      "numericCode": 2833,
      "prefix": "FR",
      "subsystem": "CFS/feed-retract",
      "messageJa": "フィラメントの送り異常です。絡まりや詰まりを確認してください。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "feature-dependent",
        "features": [
          "cfs"
        ],
        "status": "cfs-summary-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index",
        "cfs_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "creality-os:FR2835",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os",
        "cfs"
      ],
      "canonicalCode": "FR2835",
      "numericCode": 2835,
      "prefix": "FR",
      "subsystem": "CFS/feed-retract",
      "messageJa": "ローダーからCFSハブ間の送り異常です。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "feature-dependent",
        "features": [
          "cfs"
        ],
        "status": "cfs-summary-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index",
        "cfs_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "creality-os:FR2836",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os",
        "cfs"
      ],
      "canonicalCode": "FR2836",
      "numericCode": 2836,
      "prefix": "FR",
      "subsystem": "CFS/feed-retract",
      "messageJa": "CFSハブから押出機フィラメント検出器間の送り異常です。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "feature-dependent",
        "features": [
          "cfs"
        ],
        "status": "cfs-summary-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index",
        "cfs_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "creality-os:FR2839",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os",
        "cfs"
      ],
      "canonicalCode": "FR2839",
      "numericCode": 2839,
      "prefix": "FR",
      "subsystem": "CFS/feed-retract",
      "messageJa": "フィラメント切れです。補充してください。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "feature-dependent",
        "features": [
          "cfs"
        ],
        "status": "cfs-summary-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index",
        "cfs_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "creality-os:FR2848",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os",
        "cfs"
      ],
      "canonicalCode": "FR2848",
      "numericCode": 2848,
      "prefix": "FR",
      "subsystem": "CFS/feed-retract",
      "messageJa": "CFS内部でフィラメントが破断している可能性があります。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "feature-dependent",
        "features": [
          "cfs"
        ],
        "status": "cfs-summary-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index",
        "cfs_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "creality-os:FR2849",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os",
        "cfs"
      ],
      "canonicalCode": "FR2849",
      "numericCode": 2849,
      "prefix": "FR",
      "subsystem": "CFS/feed-retract",
      "messageJa": "CFSハブ位置までフィラメントを戻せません。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "feature-dependent",
        "features": [
          "cfs"
        ],
        "status": "cfs-summary-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index",
        "cfs_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "creality-os:FR2850",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os",
        "cfs"
      ],
      "canonicalCode": "FR2850",
      "numericCode": 2850,
      "prefix": "FR",
      "subsystem": "CFS/feed-retract",
      "messageJa": "CFSハブ内に別のフィラメントが入っている可能性があります。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "feature-dependent",
        "features": [
          "cfs"
        ],
        "status": "cfs-summary-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index",
        "cfs_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "creality-os:FR2851",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os",
        "cfs"
      ],
      "canonicalCode": "FR2851",
      "numericCode": 2851,
      "prefix": "FR",
      "subsystem": "CFS/feed-retract",
      "messageJa": "リトラクト中にフィラメントバッファ異常が発生しました。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "feature-dependent",
        "features": [
          "cfs"
        ],
        "status": "cfs-summary-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index",
        "cfs_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "creality-os:FR2865",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os",
        "cfs"
      ],
      "canonicalCode": "FR2865",
      "numericCode": 2865,
      "prefix": "FR",
      "subsystem": "CFS/feed-retract",
      "messageJa": "押出機からフィラメントを正常に抜けない／搬送できない状態です。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "feature-dependent",
        "features": [
          "cfs"
        ],
        "status": "global-index-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index"
      ],
      "confidence": "medium-high",
      "notes": []
    },
    {
      "id": "creality-os:FR5028",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os",
        "cfs"
      ],
      "canonicalCode": "FR5028",
      "numericCode": 5028,
      "prefix": "FR",
      "subsystem": "CFS/feed-retract",
      "messageJa": "フィラメント交換時に現在のフィラメントを正常にリトラクトできません。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [
          "K1C 2025",
          "CFS-C series"
        ],
        "k1": "yes",
        "k2": "feature-dependent",
        "features": [
          "cfs"
        ],
        "status": "verified-supplemental-model-scope"
      },
      "sources": [
        "creality_os_index",
        "fr5028"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "creality-os:FS2831",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os",
        "cfs"
      ],
      "canonicalCode": "FS2831",
      "numericCode": 2831,
      "prefix": "FS",
      "subsystem": "CFS/system",
      "messageJa": "CFSとの通信に問題があります。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "feature-dependent",
        "features": [
          "cfs"
        ],
        "status": "cfs-summary-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index",
        "cfs_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "creality-os:FS2834",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os",
        "cfs"
      ],
      "canonicalCode": "FS2834",
      "numericCode": 2834,
      "prefix": "FS",
      "subsystem": "CFS/system",
      "messageJa": "CFSシステムエラーです。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [
          "K2 Plus",
          "K2 Pro",
          "K2",
          "Creality Hi"
        ],
        "k1": "unknown",
        "k2": "yes",
        "features": [
          "cfs"
        ],
        "status": "verified-individual-page"
      },
      "sources": [
        "creality_os_index",
        "cfs_official_summary",
        "fs2834"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "creality-os:FS2840",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os",
        "cfs"
      ],
      "canonicalCode": "FS2840",
      "numericCode": 2840,
      "prefix": "FS",
      "subsystem": "CFS/system",
      "messageJa": "現在の状態では指定コマンドを実行できません。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "feature-dependent",
        "features": [
          "cfs"
        ],
        "status": "cfs-summary-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index",
        "cfs_official_summary"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "creality-os:FS2843",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os",
        "cfs"
      ],
      "canonicalCode": "FS2843",
      "numericCode": 2843,
      "prefix": "FS",
      "subsystem": "CFS/system",
      "messageJa": "RFIDを読み取れません。フィラメント情報を手動で編集してください。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [
          "K2 Plus",
          "K2 Pro",
          "K2",
          "Creality Hi"
        ],
        "k1": "unknown",
        "k2": "yes",
        "features": [
          "cfs"
        ],
        "status": "verified-individual-page"
      },
      "sources": [
        "creality_os_index",
        "cfs_official_summary",
        "fs2843"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "creality-os:FS2858",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os",
        "cfs"
      ],
      "canonicalCode": "FS2858",
      "numericCode": 2858,
      "prefix": "FS",
      "subsystem": "CFS/system",
      "messageJa": "CFSのEEPROMが異常です。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [
          "K2 Plus",
          "K2 Pro",
          "K2",
          "Creality Hi"
        ],
        "k1": "unknown",
        "k2": "yes",
        "features": [
          "cfs"
        ],
        "status": "verified-individual-page"
      },
      "sources": [
        "creality_os_index",
        "cfs_official_summary",
        "fs2858"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "creality-os:FS2861",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os",
        "cfs"
      ],
      "canonicalCode": "FS2861",
      "numericCode": 2861,
      "prefix": "FS",
      "subsystem": "CFS/system",
      "messageJa": "CFS左側RFID基板が異常です。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [
          "K2 Plus",
          "K2 Pro",
          "K2",
          "Creality Hi"
        ],
        "k1": "unknown",
        "k2": "yes",
        "features": [
          "cfs"
        ],
        "status": "verified-individual-page"
      },
      "sources": [
        "creality_os_index",
        "cfs_official_summary",
        "fs2861"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "creality-os:FS2862",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os",
        "cfs"
      ],
      "canonicalCode": "FS2862",
      "numericCode": 2862,
      "prefix": "FS",
      "subsystem": "CFS/system",
      "messageJa": "CFS右側RFID基板が異常です。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [
          "K2 Plus",
          "K2 Pro",
          "K2",
          "Creality Hi"
        ],
        "k1": "unknown",
        "k2": "yes",
        "features": [
          "cfs"
        ],
        "status": "verified-individual-page"
      },
      "sources": [
        "creality_os_index",
        "cfs_official_summary",
        "fs2862"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "creality-os:TC2841",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os"
      ],
      "canonicalCode": "TC2841",
      "numericCode": 2841,
      "prefix": "TC",
      "subsystem": "toolhead/cutter",
      "messageJa": "フィラメントカッターが詰まっている、または正しく装着されていない可能性があります。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "unknown",
        "features": [],
        "status": "global-index-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index"
      ],
      "confidence": "medium-high",
      "notes": []
    },
    {
      "id": "creality-os:TC2854",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os"
      ],
      "canonicalCode": "TC2854",
      "numericCode": 2854,
      "prefix": "TC",
      "subsystem": "toolhead/cutter",
      "messageJa": "押出機内のフィラメントがカッター校正を妨げています。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "unknown",
        "features": [],
        "status": "global-index-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index"
      ],
      "confidence": "medium-high",
      "notes": []
    },
    {
      "id": "creality-os:TC2855",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os"
      ],
      "canonicalCode": "TC2855",
      "numericCode": 2855,
      "prefix": "TC",
      "subsystem": "toolhead/cutter",
      "messageJa": "フィラメントカッターの校正に失敗しました。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "unknown",
        "features": [],
        "status": "global-index-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index"
      ],
      "confidence": "medium-high",
      "notes": []
    },
    {
      "id": "creality-os:TC2856",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os"
      ],
      "canonicalCode": "TC2856",
      "numericCode": 2856,
      "prefix": "TC",
      "subsystem": "toolhead/cutter",
      "messageJa": "フィラメントカッターが詰まっている、または欠落している可能性があります。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "unknown",
        "features": [],
        "status": "global-index-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index"
      ],
      "confidence": "medium-high",
      "notes": []
    },
    {
      "id": "creality-os:TE2111",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os"
      ],
      "canonicalCode": "TE2111",
      "numericCode": 2111,
      "prefix": "TE",
      "subsystem": "toolhead/extrusion-temp",
      "messageJa": "ノズル温度が最低押出温度未満です。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "unknown",
        "features": [],
        "status": "global-index-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index"
      ],
      "confidence": "medium-high",
      "notes": []
    },
    {
      "id": "creality-os:TE2509",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os"
      ],
      "canonicalCode": "TE2509",
      "numericCode": 2509,
      "prefix": "TE",
      "subsystem": "toolhead/extrusion-temp",
      "messageJa": "ノズルサーミスタが断線／未接続の可能性があります。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [
          "K1 series",
          "V3 series",
          "Nebula screen",
          "K2 series",
          "Creality Hi"
        ],
        "k1": "yes",
        "k2": "yes",
        "features": [],
        "status": "verified-individual-page"
      },
      "sources": [
        "creality_os_index",
        "individual_te2509"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "creality-os:TE2515",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os"
      ],
      "canonicalCode": "TE2515",
      "numericCode": 2515,
      "prefix": "TE",
      "subsystem": "toolhead/extrusion-temp",
      "messageJa": "ノズル温度が上限を超えた、またはサーミスタ短絡の可能性があります。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "unknown",
        "features": [],
        "status": "global-index-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index"
      ],
      "confidence": "medium-high",
      "notes": []
    },
    {
      "id": "creality-os:TE2564",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os"
      ],
      "canonicalCode": "TE2564",
      "numericCode": 2564,
      "prefix": "TE",
      "subsystem": "toolhead/extrusion-temp",
      "messageJa": "ノズルが期待どおりに加熱されません。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [
          "K1 series",
          "V3 series",
          "Nebula screen",
          "K2 series",
          "Creality Hi"
        ],
        "k1": "yes",
        "k2": "yes",
        "features": [],
        "status": "verified-individual-page"
      },
      "sources": [
        "creality_os_index",
        "individual_te2564"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "creality-os:TE2761",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os"
      ],
      "canonicalCode": "TE2761",
      "numericCode": 2761,
      "prefix": "TE",
      "subsystem": "toolhead/extrusion-temp",
      "messageJa": "ノズル側レベリングセンサーのデータを読み取れません。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "unknown",
        "features": [],
        "status": "global-index-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index"
      ],
      "confidence": "medium-high",
      "notes": []
    },
    {
      "id": "creality-os:TE2762",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os"
      ],
      "canonicalCode": "TE2762",
      "numericCode": 2762,
      "prefix": "TE",
      "subsystem": "toolhead/extrusion-temp",
      "messageJa": "ノズル側レベリングセンサーまたはワイピング機構が異常です。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "unknown",
        "features": [],
        "status": "global-index-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index"
      ],
      "confidence": "medium-high",
      "notes": []
    },
    {
      "id": "creality-os:TE2766",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os"
      ],
      "canonicalCode": "TE2766",
      "numericCode": 2766,
      "prefix": "TE",
      "subsystem": "toolhead/extrusion-temp",
      "messageJa": "XY原点復帰に失敗し、精密ワイプを実行できません。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "unknown",
        "features": [],
        "status": "global-index-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index"
      ],
      "confidence": "medium-high",
      "notes": []
    },
    {
      "id": "creality-os:TF0501",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os"
      ],
      "canonicalCode": "TF0501",
      "numericCode": 501,
      "prefix": "TF",
      "subsystem": "toolhead/fan",
      "messageJa": "ヒートブレイクファン回転数が低すぎます。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "unknown",
        "features": [],
        "status": "global-index-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index"
      ],
      "confidence": "medium-high",
      "notes": []
    },
    {
      "id": "creality-os:TF0526",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os"
      ],
      "canonicalCode": "TF0526",
      "numericCode": 526,
      "prefix": "TF",
      "subsystem": "toolhead/fan",
      "messageJa": "モデル冷却ファン回転数が低すぎます。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "unknown",
        "features": [],
        "status": "global-index-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index"
      ],
      "confidence": "medium-high",
      "notes": []
    },
    {
      "id": "creality-os:TR0116",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os"
      ],
      "canonicalCode": "TR0116",
      "numericCode": 116,
      "prefix": "TR",
      "subsystem": "toolhead/runout-retract",
      "messageJa": "フィラメント切れを検出し、印刷を一時停止しました。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "unknown",
        "features": [],
        "status": "global-index-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index"
      ],
      "confidence": "medium-high",
      "notes": []
    },
    {
      "id": "creality-os:TR2852",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os"
      ],
      "canonicalCode": "TR2852",
      "numericCode": 2852,
      "prefix": "TR",
      "subsystem": "toolhead/runout-retract",
      "messageJa": "フィラメント検出器が異常に反応しています。外部スプール/CFS状態を確認してください。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "unknown",
        "features": [],
        "status": "global-index-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index"
      ],
      "confidence": "medium-high",
      "notes": []
    },
    {
      "id": "creality-os:TR2863",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os"
      ],
      "canonicalCode": "TR2863",
      "numericCode": 2863,
      "prefix": "TR",
      "subsystem": "toolhead/runout-retract",
      "messageJa": "リトラクト異常です。押出機内でフィラメントが破断している可能性があります。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "unknown",
        "features": [],
        "status": "global-index-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index"
      ],
      "confidence": "medium-high",
      "notes": []
    },
    {
      "id": "creality-os:XS2000",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os"
      ],
      "canonicalCode": "XS2000",
      "numericCode": 2000,
      "prefix": "XS",
      "subsystem": "system",
      "messageJa": "システムエラーです。再起動を試してください。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "unknown",
        "features": [],
        "status": "global-index-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index"
      ],
      "confidence": "medium-high",
      "notes": []
    },
    {
      "id": "creality-os:XS2001",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os"
      ],
      "canonicalCode": "XS2001",
      "numericCode": 2001,
      "prefix": "XS",
      "subsystem": "system",
      "messageJa": "システムが停止要求を受けました。直前の非XSエラーも確認してください。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [
          "K1 series",
          "V3 series",
          "K2 series",
          "Nebula screen",
          "Creality Hi"
        ],
        "k1": "yes",
        "k2": "yes",
        "features": [],
        "status": "verified-individual-page"
      },
      "sources": [
        "creality_os_index",
        "xs2001"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "creality-os:XS2060",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os"
      ],
      "canonicalCode": "XS2060",
      "numericCode": 2060,
      "prefix": "XS",
      "subsystem": "system",
      "messageJa": "システム内部エラーです。再起動し、直前の非XSエラーを確認してください。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [
          "K1 series",
          "V3 series",
          "K2 series",
          "Nebula screen",
          "Creality Hi"
        ],
        "k1": "yes",
        "k2": "yes",
        "features": [],
        "status": "verified-individual-page"
      },
      "sources": [
        "creality_os_index",
        "xs2060"
      ],
      "confidence": "high",
      "notes": []
    },
    {
      "id": "creality-os:XS2093",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os"
      ],
      "canonicalCode": "XS2093",
      "numericCode": 2093,
      "prefix": "XS",
      "subsystem": "system",
      "messageJa": "システムエラーです。再起動を試してください。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "unknown",
        "features": [],
        "status": "global-index-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index"
      ],
      "confidence": "medium-high",
      "notes": []
    },
    {
      "id": "creality-os:XS2353",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os"
      ],
      "canonicalCode": "XS2353",
      "numericCode": 2353,
      "prefix": "XS",
      "subsystem": "system",
      "messageJa": "システムエラーです。再起動を試してください。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "unknown",
        "features": [],
        "status": "global-index-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index"
      ],
      "confidence": "medium-high",
      "notes": []
    },
    {
      "id": "creality-os:XS3000",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os"
      ],
      "canonicalCode": "XS3000",
      "numericCode": 3000,
      "prefix": "XS",
      "subsystem": "system",
      "messageJa": "システムエラーです。再起動を試してください。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "unknown",
        "features": [],
        "status": "global-index-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index"
      ],
      "confidence": "medium-high",
      "notes": []
    },
    {
      "id": "creality-os:XS3001",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os"
      ],
      "canonicalCode": "XS3001",
      "numericCode": 3001,
      "prefix": "XS",
      "subsystem": "system",
      "messageJa": "システムエラーです。再起動を試してください。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [],
        "k1": "unknown",
        "k2": "unknown",
        "features": [],
        "status": "global-index-listed; exact-model-page-not-verified"
      },
      "sources": [
        "creality_os_index"
      ],
      "confidence": "medium-high",
      "notes": []
    },
    {
      "id": "creality-os:XS3002",
      "namespace": "creality-os",
      "catalogs": [
        "creality-os"
      ],
      "canonicalCode": "XS3002",
      "numericCode": 3002,
      "prefix": "XS",
      "subsystem": "system",
      "messageJa": "Klipperがエラー状態です。ファームウェア／本体再起動を試してください。",
      "transportRole": "canonical-user-facing-code",
      "applicability": {
        "models": [
          "K1 series",
          "V3 series",
          "K2 series",
          "Nebula screen",
          "Creality Hi"
        ],
        "k1": "yes",
        "k2": "yes",
        "features": [],
        "status": "verified-individual-page"
      },
      "sources": [
        "creality_os_index",
        "xs3002"
      ],
      "confidence": "high",
      "notes": []
    }
  ],
  "documentationConflicts": [
    {
      "subject": "CZ2352/CZ2532",
      "canonical": "CZ2352",
      "alternate": "CZ2532",
      "decision": "CZ2352をcanonicalとする",
      "reason": "英語の現行総合索引と個別ページがCZ2352で一致。中国語索引のCZ2532は文書側の不整合として扱う。",
      "resolverRule": "数値2532を2352へ自動置換しない。明示的な文字列aliasを受信した場合のみ注記してcanonicalへ寄せる。"
    },
    {
      "subject": "FO2936 page slug",
      "canonical": "FO2936",
      "alternate": "FO2836 (URL slug conflict observed)",
      "decision": "FO2936をcanonicalとする",
      "reason": "現行総合索引とページ見出しのコードを優先。適用はSPARKX i7でK1/K2対象外。",
      "resolverRule": "K1/K2の数値2936候補として採用しない。"
    },
    {
      "subject": "K1 key2507 transition",
      "canonical": "2564/2565 on newer K1 firmware",
      "alternate": "2507",
      "decision": "2507はhistorical supplementとして保持",
      "reason": "旧ファームウェアと新ファームウェアで加熱異常コード体系が移行。",
      "resolverRule": "firmware不明時は2507を消さず、履歴コードとして表示する。"
    }
  ],
  "crealityOsSuffixCollisions": {},
  "rawTransportEvidence": {
    "k2": {
      "shape": {
        "err": {
          "errcode": "number",
          "key": "number",
          "value": "string"
        }
      },
      "source": "k2_ws_re",
      "note": "公開リバースエンジニアリングでK2 Plusのport 9999 WebSocket payloadを確認。"
    }
  },
  "knownObservedCases": [
    {
      "model": "K2 Pro",
      "raw": {
        "errcode": 1001,
        "key": 2843
      },
      "context": [
        "CFS"
      ],
      "resolved": "FS2843",
      "reason": "K2 Pro + CFSでnumeric suffix 2843の公式該当コードがFS2843。個別公式ページでK2 Pro適用を確認。",
      "confidence": "high"
    }
  ]
});

/**
 * Creality error resolver が参照する flat records。
 *
 * @constant {Array<Object>}
 */
export const CREALITY_ERROR_RECORDS = Object.freeze(CREALITY_ERROR_MASTER.records || []);
