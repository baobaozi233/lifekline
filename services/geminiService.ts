import { UserInput, LifeDestinyResult, Gender } from "../types";
import { BAZI_SYSTEM_INSTRUCTION } from "../constants";

/**
 * 注意：
 * - 本实现从 Vite 的环境变量读取 API Key（VITE_OPENAI_KEY），并直接在浏览器端调用 OpenAI。
 * - 生产环境请尽量改为后端中转以保护密钥并在服务器端做解析与重试。
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
  if (!Array.isArray(chart)) return false;
  if (!analysis || typeof analysis !== 'object') return false;
  if (!Array.isArray(analysis.bazi)) return false;
  return true;
};

/**
 * Try to find the first balanced JSON object or array in a string.
 * This function handles string delimiters and escapes to avoid cutting inside strings.
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
        // basic matching; if mismatch, still continue
        if (!last) {
          // unmatched closing; skip
        }
        if (stack.length === 0) {
          // found balanced JSON from startIdx .. i
          return s.slice(startIdx, i + 1);
        }
      }
    }
  }
  // no balanced block found
  return null;
}

/**
 * Remove trailing commas before } or ] which commonly cause JSON.parse errors.
 * e.g. {"a":1,}  or [1,2,]
 */
function removeTrailingCommas(jsonLike: string): string {
  // remove trailing commas in objects/arrays
  return jsonLike
    .replace(/,\s*}/g, '}')
    .replace(/,\s*]/g, ']');
}

/**
 * Some other small repairs: convert single quotes used as string delimiters to double quotes,
 * but only when safe-ish: not when there's already double quotes. This is heuristic and optional.
 */
function singleQuotesToDouble(jsonLike: string): string {
  // naive: only replace single-quoted strings that don't contain double quotes
  // This is risky; keep conservative: replace patterns like 'text' => "text"
  return jsonLike.replace(/'([^'\\]*(\\.[^'\\]*)*)'/g, (_m, g1) => {
    // escape any double quotes inside captured group
    const fixed = g1.replace(/"/g, '\\"');
    return `"${fixed}"`;
  });
}

/**
 * Try multiple strategies to parse the model output into JSON.
 */
function safeParseModelJson(content: string): any {
  // 1. direct parse
  try {
    return JSON.parse(content);
  } catch (e) {
    // continue to extraction/repair
  }

  // 2. extract between explicit markers if present
  const startMarker = "###JSON_START###";
  const endMarker = "###JSON_END###";
  if (content.includes(startMarker) && content.includes(endMarker)) {
    const between = content.split(startMarker)[1]?.split(endMarker)[0];
    if (between) {
      const cleaned = removeTrailingCommas(between.trim());
      try {
        return JSON.parse(cleaned);
      } catch (_e) {
        // fall through to next attempts
      }
    }
  }

  // 3. try to find first balanced JSON block
  const block = findBalancedJSON(content);
  if (block) {
    // attempt repairs
    let attempt = block;
    // remove common trailing commas
    attempt = removeTrailingCommas(attempt);
    try {
      return JSON.parse(attempt);
    } catch (_e) {
      // try converting single quotes to double quotes (heuristic)
      try {
        const conv = singleQuotesToDouble(attempt);
        const conv2 = removeTrailingCommas(conv);
        return JSON.parse(conv2);
      } catch (_e2) {
        // continue to last resort
      }
    }
  }

  // 4. last resort: try to strip non-JSON prefix/suffix and extract the largest {...} or [...] substring
  const objMatches = content.match(/\{[\s\S]*\}/);
  if (objMatches) {
    let attempt = objMatches[0];
    attempt = removeTrailingCommas(attempt);
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
    let attempt = arrMatches[0];
    attempt = removeTrailingCommas(attempt);
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

  // If all strategies fail, throw with original content for debugging
  throw new Error("无法解析模型返回的 JSON（尝试多种修复均失败）。返回内容（前 2000 字）:\n" + content.slice(0, 2000));
}

export const generateLifeAnalysis = async (input: UserInput): Promise<LifeDestinyResult> => {
  // 强校验 API Key 是否存在
  if (!API_KEY) {
    console.error("OpenAI API key 未设置。请在 Vite 环境变量中添加 VITE_OPENAI_KEY。");
    throw new Error("OpenAI API key 未设置 (VITE_OPENAI_KEY)。请在 Vercel 环境变量或 .env.local 中配置。");
  }

  const genderStr = input.gender === Gender.MALE ? '男 (乾造)' : '女 (坤造)';
  const startAgeInt = parseInt(input.startAge) || 1;
  
  // Calculate Da Yun Direction accurately
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

  // Encourage model to return strict JSON only, wrapped in clear markers to help extraction.
  const userPrompt = `
    请根据以下**已经排好的**八字四柱和**指定的大运信息**进行分析。

    【基本信息】
    性别：${genderStr}
    姓名：${input.name || "未提供"}
    出生年份：${input.birthYear}年 (阳历)

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

    重要要求（请严格遵守）：
    1) 返回内容必须是一个合法的 JSON 对象，不要在 JSON 之外输出任何解释性文本。
    2) 为了便于程序抽取，请把 JSON 用下面的标记包裹（并只在这两个标记之间输出 JSON）：
       ###JSON_START###
       ${'```json'}
       { ... }
       ${'```'}
       ###JSON_END###
    3) JSON 中字段请严格按照 system instruction 中的结构返回（包含 chartData/chartPoints 与 analysis）。
    4) 尽量不要使用单引号作为字符串边界；使用双引号。
    5) 如果无法做到完全严格 JSON，请至少把 JSON 放在上面指定的标记内部。
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
        temperature: 0.0, // reduce randomness to improve structured output
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

    // Try safe parse with multiple heuristics/repairs
    let data: any;
    try {
      data = safeParseModelJson(content);
    } catch (e: any) {
      // include original content for debugging in the thrown error
      throw new Error(`无法解析模型返回的 JSON（尝试抽取失败）: ${e.message}`);
    }

    if (!validateLifeDestinyData(data)) {
      throw new Error("模型返回的数据不完整或格式不正确。请检查 prompt 或模型输出格式。");
    }

    const chartData = data.chartPoints || data.chartData;
    const analysis = data.analysis;

    return {
      chartData,
      analysis
    } as LifeDestinyResult;
  } catch (err: any) {
    console.error("generateLifeAnalysis 错误：", err);
    throw new Error(err?.message || 'generateLifeAnalysis 发生未知错误');
  }
};
