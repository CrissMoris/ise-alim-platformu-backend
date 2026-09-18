/**
 * Pure scoring engine for character/value assessments.
 * - No "good/bad person" labels.
 * - Dimension-based 0-100 scores.
 * - Reverse-coded consistency check.
 * - Output is descriptive, designed for human reviewers.
 */

export type AnswerValue =
  | { type: "likert"; value: number }
  | { type: "choice"; value: string }
  | { type: "rank"; value: string[] }
  | { type: "text"; value: string };

export type ScoringQuestion = {
  id: string;
  type: "LIKERT" | "MULTIPLE_CHOICE" | "PRIORITY_RANK" | "SHORT_TEXT" | "SCENARIO_CHOICE";
  reverseScored: boolean;
  options: { value: string; score: number; order: number }[];
  dimensions: { dimension: string; weight: number }[];
};

export type DimensionAccumulator = {
  weighted: number;
  weight: number;
};

export type ScoringResult = {
  dimensionScores: Record<string, number>; // 0..100
  consistencyScore: number; // 0..100
  rawByQuestion: Record<string, number>; // 0..1 normalized
  followUpQuestions: string[];
};

/** Normalize an answer's raw value to a 0..1 scale (1.0 = strong positive). */
export function normalizeAnswer(q: ScoringQuestion, value: AnswerValue): number | null {
  if (q.type === "LIKERT" && value.type === "likert") {
    const max = q.options.reduce((m, o) => Math.max(m, o.score), 0) || 5;
    const min = q.options.reduce((m, o) => Math.min(m, o.score), Infinity);
    const range = Math.max(1, max - min);
    const opt = q.options.find((o) => o.value === String(value.value));
    const raw = opt ? opt.score : value.value;
    let n = (raw - min) / range;
    if (q.reverseScored) n = 1 - n;
    return clamp01(n);
  }
  if ((q.type === "MULTIPLE_CHOICE" || q.type === "SCENARIO_CHOICE") && value.type === "choice") {
    const opt = q.options.find((o) => o.value === value.value);
    if (!opt) return null;
    const max = q.options.reduce((m, o) => Math.max(m, o.score), 0) || 5;
    const min = q.options.reduce((m, o) => Math.min(m, o.score), Infinity);
    const range = Math.max(1, max - min);
    let n = (opt.score - min) / range;
    if (q.reverseScored) n = 1 - n;
    return clamp01(n);
  }
  if (q.type === "PRIORITY_RANK" && value.type === "rank") {
    // Score: how high "integrity"-like values are placed (lower index = higher priority).
    // Use option.score as the "ideal placement multiplier"; reward higher-scored options being first.
    const ranks = value.value;
    if (!ranks.length) return null;
    let total = 0;
    let weightSum = 0;
    for (let i = 0; i < ranks.length; i++) {
      const opt = q.options.find((o) => o.value === ranks[i]);
      const optScore = opt?.score ?? 0;
      const positionWeight = 1 - i / Math.max(1, ranks.length - 1); // 1..0
      total += positionWeight * optScore;
      weightSum += Math.max(1, optScore);
    }
    const max = q.options.reduce((m, o) => m + o.score, 0) || 1;
    return clamp01(total / Math.max(1, max));
  }
  if (q.type === "SHORT_TEXT" && value.type === "text") {
    const len = value.value.trim().length;
    if (!len) return null;
    // text quality not auto-scored; contribute partial signal: presence + reasonable length
    return clamp01(Math.min(1, len / 280));
  }
  return null;
}

function clamp01(n: number) {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

export function scoreAssessment(
  questions: ScoringQuestion[],
  answers: Record<string, AnswerValue>,
): ScoringResult {
  const accum: Record<string, DimensionAccumulator> = {};
  const rawByQuestion: Record<string, number> = {};
  let pairs: { qid: string; norm: number; reverse: boolean }[] = [];

  for (const q of questions) {
    const a = answers[q.id];
    if (!a) continue;
    const norm = normalizeAnswer(q, a);
    if (norm == null) continue;
    rawByQuestion[q.id] = norm;
    pairs.push({ qid: q.id, norm, reverse: q.reverseScored });

    for (const d of q.dimensions) {
      if (!accum[d.dimension]) accum[d.dimension] = { weighted: 0, weight: 0 };
      const w = Math.abs(d.weight);
      accum[d.dimension].weighted += norm * w * Math.sign(d.weight || 1);
      accum[d.dimension].weight += w;
    }
  }

  const dimensionScores: Record<string, number> = {};
  for (const [dim, acc] of Object.entries(accum)) {
    if (acc.weight <= 0) continue;
    dimensionScores[dim] = clamp01(acc.weighted / acc.weight) * 100;
  }

  // Consistency: variance of normalized answers between non-reverse and reverse mirror items.
  // Lower spread => higher consistency.
  const consistencyScore = computeConsistency(pairs);

  const followUpQuestions = generateFollowUps(dimensionScores);

  return {
    dimensionScores,
    consistencyScore,
    rawByQuestion,
    followUpQuestions,
  };
}

function computeConsistency(pairs: { qid: string; norm: number; reverse: boolean }[]): number {
  if (pairs.length < 4) return 80; // default neutral
  const direct = pairs.filter((p) => !p.reverse).map((p) => p.norm);
  const reverse = pairs.filter((p) => p.reverse).map((p) => p.norm);
  if (!direct.length || !reverse.length) {
    // fall back to overall variance
    const mean = avg(pairs.map((p) => p.norm));
    const variance = avg(pairs.map((p) => (p.norm - mean) ** 2));
    return clamp01(1 - variance) * 100;
  }
  const dMean = avg(direct);
  const rMean = avg(reverse);
  // both should reflect same underlying tendency; difference -> inconsistency
  const delta = Math.abs(dMean - rMean);
  return clamp01(1 - delta) * 100;
}

function avg(xs: number[]) {
  return xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
}

const DIMENSION_FOLLOWUPS: Record<string, { low: string; mid: string; high: string }> = {
  empathy: {
    low: "Adayın empati boyutunda gözlemlenen sinyal düşüktü; geçmişte zor durumdaki bir ekip arkadaşına nasıl destek olduğunu somut bir örnek üzerinden konuşun.",
    mid: "Empati profili dengeli. Stres altında empati gösterdiği bir an üzerinden derinleştirin.",
    high: "Yüksek empati sinyali var; aşırı duygusal yüklenmenin karar kalitesini düşürdüğü bir an olup olmadığını sorun.",
  },
  integrity: {
    low: "Dürüstlük sinyali düşük; küçük bir kuralı 'verimlilik için' esnetmeyi düşündüğü ve sonra ne yaptığını anlatan bir örnek isteyin.",
    mid: "Dengeli dürüstlük profili; kural-merhamet çatışmasını anlatan somut bir örnek üzerinden derinleşin.",
    high: "Güçlü dürüstlük profili; bunun bir maliyet doğurduğu bir an olup olmadığını sorgulayın.",
  },
  accountability: {
    low: "Hesap verebilirlik düşük çıktı; kötü sonuç doğan bir kararını sahiplenip nasıl iletişim kurduğunu anlatmasını isteyin.",
    mid: "Sahiplenme dengeli; başarısız bir teslimden sonra paydaşlara nasıl haber verdiği üzerinden derinleşin.",
    high: "Yüksek sahiplenme; başkalarının hatalarını da üstlenme eğilimi varsa bunun riskini sorgulayın.",
  },
  ownership: {
    low: "Hata sahiplenme zayıf; 'bu benim payım' diye konuşmak zorunda kaldığı bir an isteyin.",
    mid: "Dengeli; bir hatadan sonra sürecin ne kadarının onunla ilgili olduğunu nasıl ayırt ettiğini sorun.",
    high: "Güçlü sahiplenme; ekip-ortak hatalarını tek başına taşımaya eğilimli olabilir, bunu sorgulayın.",
  },
  team_fit: {
    low: "Takım uyumu sinyali düşük; çoğunluğun fikrine katılmadığı ama yine de kararı uyguladığı bir an üzerinden konuşun.",
    mid: "Dengeli; çatışan iki ekip üyesi arasında köprü kurduğu bir örnek isteyin.",
    high: "Yüksek takım uyumu; gerektiğinde yalnız doğru kararda durabildiğini gösteren bir an isteyin.",
  },
  stress_consistency: {
    low: "Stres altında tutarlılık zayıf; baskı altında kötü bir tepki verdiği ve nasıl onardığı somut bir örnek isteyin.",
    mid: "Dengeli; en yorucu projesinde günlük rutinini nasıl koruduğu üzerinden derinleşin.",
    high: "Stres altında güçlü; bunun çevresine duygusal mesafe yaratıp yaratmadığını sorun.",
  },
  fairness: {
    low: "Adalet duygusu sinyali düşük; emsal bir karar verirken neyi öncelediğini sorgulayın.",
    mid: "Dengeli; istisna yapması gereken bir an üzerinden konuşun.",
    high: "Yüksek adalet; bunun bağlamı esnetmesi gereken durumlara nasıl uyum sağladığını sorun.",
  },
  learning_openness: {
    low: "Öğrenme açıklığı sinyali düşük; son 6 ayda fikrini değiştirdiği bir konu isteyin.",
    mid: "Dengeli; bir geri bildirimden sonra ne yaptığı üzerinden derinleşin.",
    high: "Yüksek öğrenme açıklığı; aynı zamanda kararlılık gösterebildiği bir an isteyin.",
  },
  communication_kindness: {
    low: "İletişim nezaketi düşük; zor bir mesajı verirken kullandığı somut bir cümle örneği isteyin.",
    mid: "Dengeli; karşı tarafın zor durumunda nasıl ifade tercih ettiği üzerinden derinleşin.",
    high: "Yüksek nezaket; kötü haberi netleştirmesi gereken durumlarda nasıl davrandığını sorgulayın.",
  },
  customer_sensitivity: {
    low: "Müşteri hassasiyeti düşük; müşteri/iç müşteri için kuralın dışına çıktığı bir an isteyin.",
    mid: "Dengeli; müşteri talebini reddetmek zorunda kaldığı an üzerinden konuşun.",
    high: "Yüksek müşteri hassasiyeti; bunun ekip yorgunluğuna yol açtığı bir an varsa sorun.",
  },
};

function generateFollowUps(scores: Record<string, number>): string[] {
  const out: string[] = [];
  for (const [dim, score] of Object.entries(scores)) {
    const tmpl = DIMENSION_FOLLOWUPS[dim];
    if (!tmpl) continue;
    if (score < 40) out.push(tmpl.low);
    else if (score < 70) out.push(tmpl.mid);
    else out.push(tmpl.high);
  }
  // pick lowest 5 first (most actionable in interview)
  const ranked = Object.entries(scores).sort((a, b) => a[1] - b[1]);
  const ordered: string[] = [];
  for (const [dim] of ranked) {
    const tmpl = DIMENSION_FOLLOWUPS[dim];
    if (!tmpl) continue;
    const score = scores[dim];
    const text = score < 40 ? tmpl.low : score < 70 ? tmpl.mid : tmpl.high;
    if (ordered.includes(text)) continue;
    ordered.push(text);
  }
  return ordered.slice(0, 6);
}


export const DIMENSIONS = [
  { key: "empathy", label: "Empati ve Merhamet" },
  { key: "integrity", label: "Dürüstlük ve Güvenilirlik" },
  { key: "accountability", label: "Hesap Verebilirlik" },
  { key: "ownership", label: "Hata Sahiplenme" },
  { key: "team_fit", label: "Takım Uyumu" },
  { key: "stress_consistency", label: "Stres Altında Tutarlılık" },
  { key: "fairness", label: "Adalet Duygusu" },
  { key: "learning_openness", label: "Öğrenme Açıklığı" },
  { key: "communication_kindness", label: "İletişim Nezaketi" },
  { key: "customer_sensitivity", label: "Müşteri / İnsan Hassasiyeti" },
] as const;

