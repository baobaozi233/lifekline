import { UserInput, LifeDestinyResult, Gender } from "../types";
import { BAZI_SYSTEM_INSTRUCTION } from "../constants";

/**
 * 服务职责：
 * - 从 import.meta.env 读取模型配置并调用 OpenAI（注意：前端暴露密钥有风险，生产建议 server-side 转发）
 * - 尽量安全、稳健地解析模型返回（包含多种修复策略）
 * - 增强诊断：当返回结构不满足要求时，记录原始 content 与解析后的结构，并尝试进行兼容性修复（normalize）
 *
 * 已做要点：
 * - safeParseModelJson：多策略解析/修复模型字符串为 JSON
 * - normalizeParsedData：尝试兼容常见别名和类型（例如把 "chart" / "points" / "chart_data" 映射为 chartData；把逗号分隔字符串改为数组等）
 * - 更严格的 prompt（包含最小示例并使用包裹标记），避免模型输出多余文本
 * - 当校验失败时，输出详细调试日志（Vercel 日志可见）并在错误消息中包含原始 output 的前段和解析后数据的摘要，便于快速定位
 */

// Vite 注入的环境变量（若未设置则为空字符串）
const API_KEY = (import.meta.env.VITE_OPENAI_KEY as string) || "";
const API_BASE_URL = (import.meta.env.VITE_OPENAI_BASE as string) || "https://api.openai.com/v1";
const MODEL = (import.meta.env.VITE_OPENAI_MODEL as string) || "gpt-5";

// Helper to determine stem polarity
const getStemPolarity = (pillar: string): 'YANG' | 'YIN' => {
  if (!pillar) return 'YANG'; // default
  const firstChar = pillar.trim().charAt(0);
  const yangStems = ['甲', '丙', '戊', '庚', '壬'];
  const yinStems = ['乙', '丁', '己', '辛', '癸'];

  if (yangStems.includes(firstChar)) return 'YANG';
  if (yinStems.includes(firstChar)) return 'YIN';
  return 'YANG'; // fallback
};

const validateLifeDestinyData = (data: any): boolean => {
  if (!data) return false;
  const chart = data.chartPoints || data.chartData;
  const analysis = data.analysis;
  if (!Array.isArray(chart) || chart.length === 0) return false;
  if (!analysis || typeof analysis !== 'object') return false;
  if (!Array.isArray(analysis.bazi) || analysis.bazi.length < 4) return false;
  return true;
};

/**
 * Try to find the first balanced JSON object or array in a string.
 * Handles string delimiters, escapes to avoid cutting inside strings.
 */
function findBalancedJSON(s: string): string | null {
  if (!s) return null;
  const startIdx = (() => {
    const idxObj = s.indexOf('{');
    const idxArr = s.indexOf('[');
    if (idxObj === -1) return idxArr;
    if (idxArr === -1) return idxObj;
    return Math.min(idxObj, idxArr);
  })();
  if (startIdx === -1) return null;

  const stack: string[] = [];
  let inString = false;
  let stringChar = '';
  let escaped = false;

  for (let i = startIdx; i < s.length; i++) {
    const ch = s[i];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === stringChar) {
        inString = false;
        stringChar = '';
      }
      continue;
    } else {
      if (ch === '"' || ch === "'") {
        inString = true;
        stringChar = ch;
        continue;
      }
      if (ch === '{' || ch === '[') {
        stack.push(ch);
      } else if (ch === '}' || ch === ']') {
        const last = stack.pop();
        if (stack.length === 0) {
          // found balanced JSON from startIdx .. i
          return s.slice(startIdx, i + 1);
        }
      }
    }
  }
  return null;
}

/**
 * Remove trailing commas before } or ] which commonly cause JSON.parse errors.
 */
function removeTrailingCommas(jsonLike: string): string {
  return jsonLike
    .replace(/,\s*}/g, '}')
    .replace(/,\s*]/g, ']');
}

/**
 * Convert simple single-quoted strings to double quotes (heuristic).
 */
function singleQuotesToDouble(jsonLike: string): string {
  return jsonLike.replace(/'([^'\\]*(\\.[^'\\]*)*)'/g, (_m, g1) => {
    const fixed = g1.replace(/"/g, '\\"');
    return `"${fixed}"`;
  });
}

/**
 * Attempt multiple parse-and-repair strategies and return parsed JSON or throw.
 */
function safeParseModelJson(content: string): any {
  // 1. direct parse
  try {
    return JSON.parse(content);
  } catch (e) {
    // continue to extraction/repair
  }

  // 2. explicit markers
  const startMarker = "###JSON_START###";
  const endMarker = "###JSON_END###";
  if (content.includes(startMarker) && content.includes(endMarker)) {
    const between = content.split(startMarker)[1]?.split(endMarker)[0];
    if (between) {
      const cleaned = removeTrailingCommas(between.trim());
      try {
        return JSON.parse(cleaned);
      } catch (_e) {
        // fall through
      }
    }
  }

  // 3. find first balanced JSON block
  const block = findBalancedJSON(content);
  if (block) {
    let attempt = removeTrailingCommas(block);
    try {
      return JSON.parse(attempt);
    } catch (_e) {
      try {
        const conv = singleQuotesToDouble(attempt);
        return JSON.parse(removeTrailingCommas(conv));
      } catch (_e2) {
        // continue
      }
    }
  }

  // 4. fallback match braces
  const objMatches = content.match(/\{[\s\S]*\}/);
  if (objMatches) {
    let attempt = removeTrailingCommas(objMatches[0]);
    try {
      return JSON.parse(attempt);
    } catch (_e) {
      try {
        const conv = singleQuotesToDouble(attempt);
        return JSON.parse(removeTrailingCommas(conv));
      } catch (_e2) {
        // give up
      }
    }
  }
  const arrMatches = content.match(/\[[\s\S]*\]/);
  if (arrMatches) {
    let attempt = removeTrailingCommas(arrMatches[0]);
    try {
      return JSON.parse(attempt);
    } catch (_e) {
      try {
        const conv = singleQuotesToDouble(attempt);
        return JSON.parse(removeTrailingCommas(conv));
      } catch (_e2) {
        // give up
      }
    }
  }

  // last resort
  throw new Error("无法解析模型返回的 JSON（尝试多种修复均失败）。返回内容（前 2000 字）:\n" + content.slice(0, 2000));
}

/**
 * Normalize parsed data to match expected shape.
 * - Accepts various alias names for chart data
 * - If chartData is string, try parse it
 * - Ensure analysis.bazi is an array (split if comma/space separated)
 * - Ensure chart elements have required keys where possible
 */
function normalizeParsedData(raw: any): any {
  if (!raw || typeof raw !== 'object') return raw;

  const data: any = { ...raw };

  // Normalize chart data aliases
  const aliases = ['chartData', 'chartPoints', 'chart', 'points', 'kline', 'chart_data', 'chart_points'];
  let chart: any = null;
  for (const a of aliases) {
    if (data[a] !== undefined) {
      chart = data[a];
      break;
    }
  }
  // also consider nested fields like result.chartData
  if (!chart) {
    if (data.result && typeof data.result === 'object') {
      for (const a of aliases) {
        if (data.result[a] !== undefined) {
          chart = data.result[a];
          break;
        }
      }
    }
  }

  // Try to parse stringified chart arrays
  if (typeof chart === 'string') {
    try {
      chart = JSON.parse(removeTrailingCommas(chart));
    } catch (e) {
      // try to extract JSON block
      const blk = findBalancedJSON(chart);
      if (blk) {
        try {
          chart = JSON.parse(removeTrailingCommas(blk));
        } catch (_e) {
          chart = null;
        }
      } else {
        chart = null;
      }
    }
  }

  // If we found chart, set canonical name
  if (Array.isArray(chart)) {
    data.chartData = chart.map((item: any) => {
      // if item is string attempt parse
      if (typeof item === 'string') {
        try {
          item = JSON.parse(item);
        } catch (_) {
          // leave as-is
        }
      }
      // ensure shape and convert numeric-like strings to numbers
      const normalized: any = { ...item };
      if (normalized.age !== undefined) normalized.age = Number(normalized.age) || 0;
      if (normalized.year !== undefined) normalized.year = Number(normalized.year) || Number(new Date().getFullYear());
      if (normalized.open !== undefined) normalized.open = Number(normalized.open) || 0;
      if (normalized.close !== undefined) normalized.close = Number(normalized.close) || 0;
      if (normalized.high !== undefined) normalized.high = Number(normalized.high) || normalized.open || normalized.close || 0;
      if (normalized.low !== undefined) normalized.low = Number(normalized.low) || normalized.open || normalized.close || 0;
      if (normalized.score !== undefined) normalized.score = Number(normalized.score) || 0;
      if (normalized.ganZhi === undefined && normalized.yang === undefined) {
        normalized.ganZhi = normalized.ganZhi || '';
      }
      normalized.reason = normalized.reason || (typeof normalized.reason === 'string' ? normalized.reason : '');
      return normalized;
    });
  }

  // Normalize analysis.bazi
  if (data.analysis && typeof data.analysis === 'object') {
    const bazi = data.analysis.bazi;
    if (typeof bazi === 'string') {
      // split by comma/Chinese comma/whitespace
      const arr = bazi.split(/[,，\s]+/).map((s: string) => s.trim()).filter(Boolean);
      data.analysis.bazi = arr;
    } else if (!Array.isArray(bazi) && bazi !== undefined) {
      // attempt to coerce to array if possible
      data.analysis.bazi = Array.isArray(bazi) ? bazi : [bazi];
    }
  }

  // If no chartData but data.chart exists as object (maybe single-year), attempt wrap
  if (!Array.isArray(data.chartData)) {
    const maybe = raw.chart || raw.points || raw.kline || (raw.result && (raw.result.chart || raw.result.points));
    if (maybe) {
      if (Array.isArray(maybe)) data.chartData = maybe;
      else if (typeof maybe === 'object') data.chartData = [maybe];
    }
  }

  return data;
}

export const generateLifeAnalysis = async (input: UserInput): Promise<LifeDestinyResult> => {
  if (!API_KEY) {
    console.error("OpenAI API key 未设置。请在 Vite 环境变量中添加 VITE_OPENAI_KEY。");
    throw new Error("OpenAI API key 未设置 (VITE_OPENAI_KEY)。请在 Vercel 环境变量或 .env.local 中配置。");
  }

  const genderStr = input.gender === Gender.MALE ? '男 (乾造)' : '女 (坤造)';
  const startAgeInt = parseInt(input.startAge) || 1;

  const yearStemPolarity = getStemPolarity(input.yearPillar);
  let isForward = false;
  if (input.gender === Gender.MALE) {
    isForward = yearStemPolarity === 'YANG';
  } else {
    isForward = yearStemPolarity === 'YIN';
  }

  const daYunDirectionStr = isForward ? '顺行 (Forward)' : '逆行 (Backward)';
  const directionExample = isForward
    ? "例如：第一步是【戊申】，第二步则是【己酉】（顺排）"
    : "例如：第一步是【戊申】，第二步则是【丁未】（逆排）";

  // Provide a minimal JSON example to the model to reduce format variance.
  const minimalExample = {
    chartData: [
      {
        age: 1,
        year: 1990,
        ganZhi: "甲子",
        daYun: "甲子",
        open: 50,
        close: 55,
        high: 60,
        low: 45,
        score: 6,
        reason: "示例：该年有利于学习与积累，注意健康。"
      }
    ],
    analysis: {
      bazi: ["甲子", "乙丑", "丙寅", "丁卯"],
      summary: "示例摘要",
      summaryScore: 6,
      industry: "示例",
      industryScore: 6,
      wealth: "示例",
      wealthScore: 6,
      marriage: "示例",
      marriageScore: 6,
      health: "示例",
      healthScore: 6,
      family: "示例",
      familyScore: 6
    }
  };

  // Use marker-wrapping to help extraction. Avoid embedding raw backticks by using ${'```json'} trick.
  const userPrompt = `
    请根据以下**已经排好的**八字四柱和**指定的大运信息**进行分析。

    【基本信息】
    性别：${genderStr}
    姓名：${input.name || "未提供"}
    出生年份：${input.birthYear || "未知"}年 (阳历)

    【八字四柱】
    年柱：${input.yearPillar}
    月柱：${input.monthPillar}
    日柱：${input.dayPillar}
    时柱：${input.hourPillar}

    【起运与大运】
    起运年龄（虚岁）：${input.startAge}
    第一步大运：${input.firstDaYun}
    大运方向：${daYunDirectionStr}，${directionExample}

    ${BAZI_SYSTEM_INSTRUCTION}

    请严格遵守以下要求：
    1) 只输出一个合法的 JSON 对象（不要在 JSON 之外输出任何文字说明）。
    2) 为便于程序抽取，请把 JSON 用下面的标记包裹（并只在这两个标记之间输出 JSON）：
       ###JSON_START###
       ${'```json'}
       ${JSON.stringify(minimalExample)}
       ${'```'}
       ###JSON_END###
    3) JSON 字段名请严格按模板返回，chartData 必须是数组，analysis.bazi 必须是字符串数组。
    4) 避免把数组作为字符串返回；字符串请使用双引号。
    5) 如果无法完整生成整套 1-100 岁的数据，请至少保证 chartData 为非空数组并在 analysis 中返回 bazi（数组）。
  `;

  try {
    const res = await fetch(`${API_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: BAZI_SYSTEM_INSTRUCTION },
          { role: "user", content: userPrompt }
        ],
        temperature: 0.0,
        max_tokens: 4000
      })
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`API 请求失败: ${res.status} - ${errText}`);
    }

    const jsonResult = await res.json();
    const content = jsonResult.choices?.[0]?.message?.content;

    if (!content) {
      throw new Error("模型未返回任何内容。");
    }

    // Parse with repair heuristics
    let data: any;
    try {
      data = safeParseModelJson(content);
    } catch (e: any) {
      throw new Error(`无法解析模型返回的 JSON（尝试抽取失败）: ${e.message}`);
    }

    // Try normalization to accept common variants
    const normalized = normalizeParsedData(data);

    // Validate normalized result
    if (!validateLifeDestinyData(normalized)) {
      // Detailed debug logging - will appear in Vercel logs
      console.error("[generateLifeAnalysis] 模型原始输出（前4000字符）:\n", content.slice(0, 4000));
      console.error("[generateLifeAnalysis] 解析后对象顶层键：", Object.keys(data || {}));
      console.error("[generateLifeAnalysis] 规范化后顶层键：", Object.keys(normalized || {}));
      console.error("[generateLifeAnalysis] chartData isArray:", Array.isArray(normalized?.chartData), "length:", normalized?.chartData?.length);
      console.error("[generateLifeAnalysis] analysis type:", typeof normalized?.analysis, "bazi isArray:", Array.isArray(normalized?.analysis?.bazi));
      // throw error with helpful snapshot
      throw new Error(
        "模型返回的数据不完整或格式不正确。请检查 prompt 或模型输出格式。\n\n" +
        "原始输出（前2000字）:\n" + content.slice(0, 2000) + "\n\n" +
        "解析后数据（JSON 前500字）:\n" + JSON.stringify(normalized).slice(0, 500)
      );
    }

    const chartData = normalized.chartData;
    const analysis = normalized.analysis;

    return {
      chartData,
      analysis
    } as LifeDestinyResult;
  } catch (err: any) {
    console.error("generateLifeAnalysis 错误：", err);
    throw new Error(err?.message || 'generateLifeAnalysis 发生未知错误');
  }
};
