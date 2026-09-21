/**
 * 页面配置相关的纯函数：Key 掩码 与 配置状态。
 * 只读环境变量，不写文件。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { readFileSync, rmSync, writeFileSync } from "node:fs";

import {
  CONFIG_FILE,
  configStatus,
  loadStoredConfig,
  maskKey,
  saveStoredConfig,
} from "../server/config.ts";

function withEnv<T>(patch: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(patch)) saved[k] = process.env[k];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/* ------------------------------------------------------------------ */
/* 掩码：界面上只能看到头尾，够确认「填的是哪个」就行                     */
/* ------------------------------------------------------------------ */

test("长 Key 只露头 8 位和尾 4 位", () => {
  assert.equal(
    maskKey("apikey_295a82823dcdd6d46c5b9b69d6de237343d_0b7ad657"),
    "apikey_2…d657",
  );
});

test("短 Key 全部打码，不泄露长度规律", () => {
  assert.equal(maskKey("short"), "••••••");
  assert.equal(maskKey("123456789012"), "••••••");
});

test("空 Key 返回空串", () => {
  assert.equal(maskKey(""), "");
});

/* ------------------------------------------------------------------ */
/* 配置状态                                                            */
/* ------------------------------------------------------------------ */

test("没配 Key 时明确标记未配置", () => {
  withEnv({ TYPESAFE_API_KEY: undefined, LLM_API_KEY: undefined }, () => {
    const s = configStatus();
    assert.equal(s.typesafe.configured, false);
    assert.equal(s.typesafe.preview, "");
    assert.equal(s.typesafe.source, null);
    assert.equal(s.llm.configured, false);
  });
});

test("配了 Key 时给出掩码预览", () => {
  withEnv({ TYPESAFE_API_KEY: "apikey_abcdefghijklmnop" }, () => {
    const s = configStatus();
    assert.equal(s.typesafe.configured, true);
    assert.ok(s.typesafe.preview.includes("…"), "预览应带省略号");
    assert.ok(
      !s.typesafe.preview.includes("efghijklmn"),
      "预览不能包含 Key 的中间部分",
    );
  });
});

test("大模型未单独指定地址时回落到 DeepSeek 默认值", () => {
  withEnv(
    { LLM_API_KEY: "sk-x", LLM_BASE_URL: undefined, LLM_MODEL: undefined },
    () => {
      const s = configStatus();
      assert.equal(s.llm.baseUrl, "https://api.deepseek.com");
      assert.equal(s.llm.model, "deepseek-chat");
    },
  );
});

test("配了大模型 Key 时 configured 为真", () => {
  withEnv({ LLM_API_KEY: "sk-abcdefghijklmnop" }, () => {
    assert.equal(configStatus().llm.configured, true);
  });
});

/* ------------------------------------------------------------------ */
/* 落盘往返（操作真实的 .config.json，前后备份恢复，不留痕）              */
/* ------------------------------------------------------------------ */

function withConfigFile<T>(fn: () => T): T {
  let backup: string | null = null;
  try {
    backup = readFileSync(CONFIG_FILE, "utf8");
  } catch {
    backup = null;
  }
  try {
    return fn();
  } finally {
    if (backup !== null) writeFileSync(CONFIG_FILE, backup, "utf8");
    else rmSync(CONFIG_FILE, { force: true });
  }
}

test("保存后能读回，清空某项只移除该项", () => {
  withConfigFile(() => {
    saveStoredConfig({ llmApiKey: "sk-test-123", llmModel: "qwen-plus" });
    const saved = loadStoredConfig();
    assert.equal(saved.llmApiKey, "sk-test-123");
    assert.equal(saved.llmModel, "qwen-plus");

    saveStoredConfig({ llmApiKey: "" });
    const after = loadStoredConfig();
    assert.equal(after.llmApiKey, undefined, "清空后应从文件里移除");
    assert.equal(after.llmModel, "qwen-plus", "没动的项要保留");
  });
});

test("首尾空白会被裁掉", () => {
  withConfigFile(() => {
    saveStoredConfig({ llmApiKey: "  sk-trim  " });
    assert.equal(loadStoredConfig().llmApiKey, "sk-trim");
  });
});

test("文件损坏时当作未配置，而不是让服务起不来", () => {
  withConfigFile(() => {
    writeFileSync(CONFIG_FILE, "{ 这不是合法 JSON", "utf8");
    assert.deepEqual(loadStoredConfig(), {});
  });
});
