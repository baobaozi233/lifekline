import { UserInput, LifeDestinyResult, Gender } from "../types";
import { BAZI_SYSTEM_INSTRUCTION } from "../constants";

/**
 * 注意：
 * - 本实现从 Vite 的环境变量读取 API Key（VITE_OPENAI_KEY），并直接在浏览器端调用 OpenAI。
 * - 这会把 key 打包到客户端，存在泄露风险。生产环境强烈建议使用后端中转（Vercel Serverless / API 路由）来保存与使用秘钥。
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

export const generateLifeAnalysis = async (input: UserInput): Promise<LifeDestinyResult> => {
  // 强校验 API Key 是否存在
  if (!API_KEY) {
    console.error("OpenAI API key 未设置。请在 Vite 环��变量中添加 VITE_OPENAI_KEY。");
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

    任务：请严格返回 JSON（不要在 JSON 外输出额外文本），字段需包含人生 K 线（1-100 岁）与 analysis（命理分项与评分）。
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
        temperature: 0.7,
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

    let data: any;
    try {
      data = JSON.parse(content);
    } catch (e: any) {
      // 如果模型输出中有前置/后置文本，尝试从字符串中抽取最接近 JSON 的部分
      const match = content.match(/(\{[\s\S]*\})/);
      if (match) {
        try {
          data = JSON.parse(match[1]);
        } catch (_e) {
          throw new Error(`无法解析模型返回的 JSON（尝试抽取失败）: ${_e?.message || _e}`);
        }
      } else {
        throw new Error(`无法解析模型返回的 JSON: ${e.message}`);
      }
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
    // 把错误向上抛出以便 UI 展示
    throw new Error(err?.message || 'generateLifeAnalysis 发生未知错误');
  }
};
