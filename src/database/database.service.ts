import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';
import { createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { DIMENSIONS, scoreAssessment, type AnswerValue, type ScoringQuestion } from '../scoring/assessment-scoring.js';

const otpLength = 6;
const otpTtlMs = 10 * 60 * 1000;
const otpMaxAttempts = 5;
const inviteHash = (token: string) => createHmac('sha256', process.env.INVITE_TOKEN_PEPPER ?? 'dev-invite-pepper-change-me-32-chars-min').update(token).digest('hex');
const otpHash = (code: string, salt: string) => createHmac('sha256', process.env.OTP_PEPPER ?? 'dev-otp-pepper-change-me-32-chars-min').update(`${salt}:${code}`).digest('hex');
type OtpInvite = { id: string; status: string; expiresAt: Date; candidateName: string; candidateEmail: string; organizationId: string; templateId: string; templateName: string; durationSec: number };
const unrestrictedPolicy = {
  mode: 'LENIENT', fullscreenRequired: false, allowedFocusLossCount: 1_000_000,
  allowedHiddenMs: 1_000_000_000, blockCopy: false, blockPaste: false,
  blockContextMenu: false, invalidateOnPageLeave: false,
};
const maskEmail = (email: string) => {
  const [name, domain] = email.split('@');
  if (!domain) return '***';
  const visible = name.length <= 2 ? name[0] : `${name[0]}${name[1]}`;
  return `${visible}${'*'.repeat(Math.max(2, name.length - 2))}@${domain}`;
};

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private pool: Pool;
  private queryQueue: Promise<void> = Promise.resolve();

  constructor() {
    const url = new URL(process.env.DATABASE_URL!);

    // Eski DATABASE_URL'ye dokunmuyoruz.
    // Sadece Node bağlantısı için sslmode'u URL'nin geçici kopyasından çıkarıyoruz.
    url.searchParams.delete('sslmode');

    this.pool = new Pool({
      connectionString: url.toString(),
      max: 1,
      ssl: {
        rejectUnauthorized: false,
      },
    });
  }

  async connect() {
    const client = await this.pool.connect();
    client.release();
  }

  async query<T = any>(
    text: string,
    params: any[] = [],
  ): Promise<T[]> {
    let rows: T[] = [];

    const run = this.queryQueue.then(async () => {
      const result = await this.pool.query(text, params);
      rows = result.rows as T[];
    });

    this.queryQueue = run.catch(() => {});

    await run;
    return rows;
  }

  private async transaction<T>(
    work: (query: <R = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<R[]>) => Promise<T>,
  ): Promise<T> {
    let value!: T;
    const run = this.queryQueue.then(async () => {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        try {
          const query = async <R = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
            const result = await client.query(sql, params);
            return result.rows as R[];
          };
          value = await work(query);
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      } finally {
        client.release();
      }
    });
    this.queryQueue = run.catch(() => {});
    await run;
    return value;
  }

  async testConnection() {
    return this.query('SELECT 1');
  }

  async getPositions() {
    return this.query(`
      SELECT
        id,
        title,
        department,
        level,
        description,
        "isActive",
        "createdAt"
      FROM "Position"
      ORDER BY "createdAt" DESC
    `);
  }

  async getCandidates() {
    return this.query(`
      SELECT
        id,
        "fullName",
        email,
        phone,
        "birthDate",
        district,
        "hasDriverLicense",
        "driverLicenseType",
        "activelyDriving",
        "militaryStatus",
        "foreignLanguage",
        "totalWorkExperience",
        "field",
        "cvUrl",
        "createdAt",
        score,
        "positionId",
        tags
      FROM "Candidate"
      WHERE "deletedAt" IS NULL
      ORDER BY "createdAt" DESC
    `);
  }

  async getCandidatesByPosition(positionId: string) {
    return this.query(
      `
      SELECT
        id,
        "fullName",
        email,
        phone,
        "birthDate",
        district,
        "hasDriverLicense",
        "driverLicenseType",
        "militaryStatus",
        "foreignLanguage",
        "totalWorkExperience",
        field,
        "cvUrl",
        "activelyDriving",
        "createdAt",
        score,
        "positionId",
        tags
      FROM "Candidate"
      WHERE "positionId" = $1
        AND "deletedAt" IS NULL
      ORDER BY "createdAt" DESC
      `,
      [positionId],
    );
  }

  async getDashboardStats() {
    const result = await this.query(`
      SELECT
        (
          SELECT COUNT(*)
          FROM "Candidate"
          WHERE "deletedAt" IS NULL
        ) AS "totalCandidates",

        (
          SELECT COUNT(*)
          FROM "Position"
          WHERE "isActive" = true
        ) AS "totalPositions",

        (
          SELECT COUNT(DISTINCT "candidateId")
          FROM "Invite"
          WHERE "status" IN (
            'SENT',
            'OPENED',
            'EMAIL_VERIFIED',
            'CONSENT_ACCEPTED',
            'IN_PROGRESS'
          )
        ) AS "inEvaluation",

        (
          SELECT COUNT(DISTINCT "candidateId")
          FROM "AppointmentInvite"
          WHERE "status" = 'BOOKED'
        ) AS "inInterview"
    `);

    return result[0];
  }

  async getCandidateById(id: string) {
    const candidateRows = await this.query(
      `
      SELECT
        id,
        "fullName",
        email,
        phone,
        "birthDate",
        district,
        "hasDriverLicense",
        "driverLicenseType",
        "activelyDriving",
        "militaryStatus",
        "foreignLanguage",
        "totalWorkExperience",
        field,
        "cvUrl",
        "createdAt",
        score,
        "positionId",
        notes,
        "coverLetter",
        tags
      FROM "Candidate"
      WHERE id = $1
        AND "deletedAt" IS NULL
      LIMIT 1
      `,
      [id],
    );

    const candidate = candidateRows[0];

    if (!candidate) {
      return null;
    }

    const invites = await this.query(
      `
      SELECT
        id,
        "positionId",
        status,
        "expiresAt",
        "sentAt",
        "openedAt",
        "startedAt",
        "completedAt",
        "revokedAt",
        "invalidatedAt",
        "invalidationReason",
        "createdAt"
      FROM "Invite"
      WHERE "candidateId" = $1
      ORDER BY "createdAt" DESC
      `,
      [id],
    );

    const technicalSessions = await this.query(
      `
      SELECT
        id,
        "positionId",
        status,
        "scheduledAt",
        "startedAt",
        "submittedAt",
        "evaluatedAt",
        "overallScore",
        confidence,
        "reviewerOverallScore",
        "reviewerNote",
        "createdAt"
      FROM "TechnicalInterviewSession"
      WHERE "candidateId" = $1
      ORDER BY "createdAt" DESC
      `,
      [id],
    );

    const appointmentInvites = await this.query(
      `
      SELECT
        id,
        status,
        token,
        "sentAt",
        "expiresAt"
      FROM "AppointmentInvite"
      WHERE "candidateId" = $1
      ORDER BY "sentAt" DESC
      `,
      [id],
    );

    const appointmentBookings = await this.query(
      `
      SELECT
        ab.id,
        ab."inviteId",
        ab."createdAt",
        aps."startAt"
      FROM "AppointmentBooking" ab
      INNER JOIN "AppointmentSlot" aps
        ON aps.id = ab."slotId"
      WHERE ab."candidateId" = $1
      ORDER BY aps."startAt" DESC
      `,
      [id],
    );

    // Değerlendirme sonucu
    // AssessmentResult -> Invite -> Candidate
    // DimensionScore -> AssessmentResult
    const evaluationRows = await this.query(
      `
      SELECT
        ar.id,
        ar."inviteId",
        ar."overallSummary",
        ar."consistencyScore",
        ar."completedAt",
        COALESCE(
          json_agg(
            json_build_object(
              'dimension', ds.dimension,
              'score', ds.score,
              'observation', ds.observation
            )
            ORDER BY ds.dimension
          ) FILTER (WHERE ds.id IS NOT NULL),
          '[]'::json
        ) AS dimensions
      FROM "AssessmentResult" ar
      INNER JOIN "Invite" i
        ON i.id = ar."inviteId"
      LEFT JOIN "DimensionScore" ds
        ON ds."resultId" = ar.id
      WHERE i."candidateId" = $1
      GROUP BY
        ar.id,
        ar."inviteId",
        ar."overallSummary",
        ar."consistencyScore",
        ar."completedAt"
      ORDER BY ar."completedAt" DESC
      LIMIT 1
      `,
      [id],
    );

    // İş başvuru formu
    const applicationRows = await this.query(
      `
      SELECT
        id,
        "appointmentInviteId",
        "candidateId",
        cinsiyet,
        "dogumYeriTarihi",
        "ikametgahAdresi",
        "askerlikDurumu",
        "suruculBelgesi",
        "suruculBelgesiDiger",
        "sigaraKullaniyor",
        "medeniDurum",
        "cocukSayisi",
        egitim,
        "yabanciDiller",
        "isTecrubesi",
        referanslar,
        "saglikProblem",
        "saglikProblemAciklama",
        "mahkumiyetDurumu",
        "mahkumiyetAciklama",
        "acilIletisimAdSoyad",
        "acilIletisimYakinligi",
        "acilIletisimTelefon",
        "netUcretBeklentisi",
        "isBaslangicTarihi",
        "basvurulanPozisyon",
        "submittedAt"
      FROM "JobApplicationForm"
      WHERE "candidateId" = $1
      ORDER BY "createdAt" DESC
      LIMIT 1
      `,
      [id],
    );

    return {
      ...candidate,
      invites,
      technicalSessions,
      appointmentInvites,
      appointmentBookings,
      evaluation: evaluationRows[0] ?? null,
      jobApplicationForm: applicationRows[0] ?? null,
    };
  }

  async getQuestions() {
    const questions = await this.query(`
      SELECT
        id,
        type,
        prompt,
        "helpText",
        "reverseScored",
        "isActive",
        category,
        "createdAt",
        "updatedAt"
      FROM "Question"
      WHERE "isActive" = true
      ORDER BY "createdAt" DESC
    `);

    for (const question of questions as any[]) {
      question.options = await this.query(
        `
        SELECT
          id,
          label,
          value,
          score,
          "order"
        FROM "QuestionOption"
        WHERE "questionId" = $1
        ORDER BY "order" ASC
        `,
        [question.id],
      );
    }

    return questions;
  }

  async getTechnicalQuestions() {
    return this.query(`
      SELECT
        id,
        difficulty,
        title,
        "problemStatement",
        "inputContract",
        "outputContract",
        constraints,
        "starterCode",
        language,
        "publicTestCases",
        rubric,
        "acceptedApproaches",
        "commonMistakes",
        "reviewerNotesTemplate",
        "timeLimitMs",
        "memoryLimitMB",
        "isActive",
        "createdAt",
        "updatedAt"
      FROM "TechnicalQuestion"
      WHERE "isActive" = true
      ORDER BY difficulty ASC, "createdAt" DESC
    `);
  }

  async getTechnicalSessions() {
    return this.query(`
      SELECT
        tis.id,
        tis.status,
        tis."scheduledAt",
        tis."startedAt",
        tis."submittedAt",
        tis."evaluatedAt",
        tis."overallScore",
        tis.confidence,
        tis."reviewerOverallScore",
        tis."reviewerNote",
        c.id AS "candidateId",
        c."fullName" AS "candidateName",
        p.id AS "positionId",
        p.title AS "positionTitle"
      FROM "TechnicalInterviewSession" tis
      INNER JOIN "Candidate" c
        ON c.id = tis."candidateId"
        AND c."deletedAt" IS NULL
      LEFT JOIN "Position" p
        ON p.id = tis."positionId"
      ORDER BY tis."createdAt" DESC
    `);
  }

  async createTechnicalSession(body: { candidateId: string; questionIds: string[] }, interviewerId: string, organizationId: string) {
    if (!body || typeof body.candidateId !== 'string' || !body.candidateId.trim() ||
        !Array.isArray(body.questionIds) || body.questionIds.length !== 5 ||
        body.questionIds.some((id) => typeof id !== 'string' || !id.trim()) ||
        new Set(body.questionIds).size !== 5) {
      throw new BadRequestException('Bir aday ve birbirinden farklı 5 teknik soru seçin.');
    }

    return this.transaction(async (query) => {
      const candidates = await query<{ id: string; organizationId: string; positionId: string | null }>(`
        SELECT id, "organizationId", "positionId" FROM "Candidate"
        WHERE id = $1 AND "deletedAt" IS NULL
      `, [body.candidateId]);
      const candidate = candidates[0];
      if (!candidate) throw new NotFoundException('Aday bulunamadı.');
      if (candidate.organizationId !== organizationId) throw new NotFoundException('Aday bulunamadı.');

      const questions = await query<{ id: string }>(`
        SELECT id FROM "TechnicalQuestion"
        WHERE "organizationId" = $1 AND "isActive" = true AND id = ANY($2::text[])
      `, [candidate.organizationId, body.questionIds]);
      if (questions.length !== 5) {
        throw new BadRequestException('Seçilen tüm sorular aktif ve adayın organizasyonuna ait olmalı.');
      }

      const interviewers = await query<{ id: string }>(`
        SELECT id FROM "AdminUser"
        WHERE id = $1 AND "organizationId" = $2 AND "isActive" = true AND "deletedAt" IS NULL
      `, [interviewerId, candidate.organizationId]);
      if (interviewers.length !== 1) {
        throw new ConflictException('Giriş yapan yönetici bu aday için mülakatçı olarak kullanılamıyor.');
      }

      const sessionId = randomUUID();
      await query(`
        INSERT INTO "TechnicalInterviewSession"
          (id, "organizationId", "candidateId", "positionId", "interviewerId", status, "createdAt", "updatedAt")
        VALUES ($1, $2, $3, $4, $5, 'CREATED', NOW(), NOW())
      `, [sessionId, candidate.organizationId, candidate.id, candidate.positionId, interviewers[0].id]);
      for (const [order, questionId] of body.questionIds.entries()) {
        await query(`
          INSERT INTO "TechnicalInterviewQuestion" (id, "sessionId", "questionId", "order")
          VALUES ($1, $2, $3, $4)
        `, [randomUUID(), sessionId, questionId, order]);
      }
      return { id: sessionId, status: 'CREATED' };
    });
  }

  async getTechnicalSession(id: string) {
    const sessions = await this.query(`
      SELECT tis.id, tis.status, tis."scheduledAt", tis."startedAt", tis."submittedAt",
        tis."evaluatedAt", tis."overallScore", tis.confidence,
        tis."reviewerOverallScore", tis."reviewerNote",
        c.id AS "candidateId", c."fullName" AS "candidateName",
        c.email AS "candidateEmail", c.phone AS "candidatePhone",
        p.id AS "positionId", p.title AS "positionTitle",
        a.id AS "interviewerId", a.name AS "interviewerName", a.email AS "interviewerEmail"
      FROM "TechnicalInterviewSession" tis
      INNER JOIN "Candidate" c ON c.id = tis."candidateId" AND c."deletedAt" IS NULL
      LEFT JOIN "Position" p ON p.id = tis."positionId"
      INNER JOIN "AdminUser" a ON a.id = tis."interviewerId"
      WHERE tis.id = $1
      LIMIT 1
    `, [id]);
    if (!sessions[0]) throw new NotFoundException('Teknik mülakat bulunamadı.');

    const questions = await this.query(`
      SELECT tiq."questionId", tiq."order", q.title, q.difficulty, q."problemStatement",
        q."inputContract", q."outputContract", q.constraints, q."starterCode",
        q.language, q.rubric, q."publicTestCases", q."timeLimitMs", q."memoryLimitMB"
      FROM "TechnicalInterviewQuestion" tiq
      INNER JOIN "TechnicalQuestion" q ON q.id = tiq."questionId"
      WHERE tiq."sessionId" = $1
      ORDER BY tiq."order" ASC
    `, [id]);
    const submissions = await this.query(`
      SELECT id, "questionId", language, code, explanation, "submittedAt",
        "computedScore", "testsTotal", "testsPassed", "edgeCovered",
        "performanceScore", "qualityScore", "securityScore",
        "errorHandlingScore", "explanationScore"
      FROM "TechnicalSubmission"
      WHERE "sessionId" = $1
      ORDER BY "submittedAt" DESC
    `, [id]);
    const testResults = await this.query(`
      SELECT t.id, t."submissionId", t."index", t.hidden, t.passed,
        CASE WHEN t.hidden THEN NULL ELSE t.expected END AS expected,
        CASE WHEN t.hidden THEN NULL ELSE t.actual END AS actual,
        t."errorMessage", t."durationMs"
      FROM "TechnicalTestCaseResult" t
      INNER JOIN "TechnicalSubmission" s ON s.id = t."submissionId"
      WHERE s."sessionId" = $1
      ORDER BY t."index" ASC
    `, [id]);
    const rubricScores = await this.query(`
      SELECT r.id, r."submissionId", s."questionId", r."rubricKey", r.score,
        r.weight, r.comment, r."reviewerOverride"
      FROM "TechnicalRubricScore" r
      LEFT JOIN "TechnicalSubmission" s ON s.id = r."submissionId"
      WHERE r."sessionId" = $1
      ORDER BY r."reviewerOverride" DESC, r."rubricKey" ASC
    `, [id]);
    return { ...sessions[0], questions, submissions, testResults, rubricScores, testExecutionAvailable: false };
  }

  async startTechnicalSession(id: string) {
    const rows = await this.query(`
      UPDATE "TechnicalInterviewSession"
      SET status = 'IN_PROGRESS', "startedAt" = NOW(), "updatedAt" = NOW()
      WHERE id = $1 AND status = 'CREATED'
      RETURNING id, status, "startedAt"
    `, [id]);
    if (rows[0]) return rows[0];
    const existing = await this.query('SELECT id FROM "TechnicalInterviewSession" WHERE id = $1', [id]);
    if (!existing[0]) throw new NotFoundException('Teknik mülakat bulunamadı.');
    throw new ConflictException('Yalnızca oluşturulmuş mülakat başlatılabilir.');
  }

  async submitTechnicalSession(
    id: string,
    body: { questionId: string; language: string; code: string; explanation?: string },
  ) {
    if (!body || typeof body.questionId !== 'string' || typeof body.language !== 'string' ||
        typeof body.code !== 'string' || !body.code.trim() || body.code.length > 80_000 ||
        (body.explanation !== undefined && (typeof body.explanation !== 'string' || body.explanation.length > 8_000))) {
      throw new BadRequestException('Soru, dil ve kod zorunludur; içerik sınırlarını kontrol edin.');
    }
    return this.transaction(async (query) => {
      const sessions = await query<{ id: string; status: string; organizationId: string }>(
        'SELECT id, status, "organizationId" FROM "TechnicalInterviewSession" WHERE id = $1 FOR UPDATE', [id],
      );
      const session = sessions[0];
      if (!session) throw new NotFoundException('Teknik mülakat bulunamadı.');
      if (session.status !== 'IN_PROGRESS') throw new ConflictException('Gönderim yalnızca devam eden mülakatta yapılabilir.');
      const questions = await query<{ language: string }>(`
        SELECT q.language FROM "TechnicalInterviewQuestion" tiq
        INNER JOIN "TechnicalQuestion" q ON q.id = tiq."questionId"
        WHERE tiq."sessionId" = $1 AND tiq."questionId" = $2 AND q."organizationId" = $3
      `, [id, body.questionId, session.organizationId]);
      if (!questions[0]) throw new NotFoundException('Soru bu mülakata ait değil.');
      if (questions[0].language !== body.language) throw new BadRequestException('Kod dili soru diliyle eşleşmiyor.');
      const submissionId = randomUUID();
      const submissions = await query(`
        INSERT INTO "TechnicalSubmission" (id, "sessionId", "questionId", language, code, explanation, "submittedAt")
        VALUES ($1, $2, $3, $4, $5, $6, NOW())
        RETURNING id, "questionId", language, code, explanation, "submittedAt"
      `, [submissionId, id, body.questionId, body.language, body.code, body.explanation?.trim() || null]);
      await query('UPDATE "TechnicalInterviewSession" SET "submittedAt" = NOW(), "updatedAt" = NOW() WHERE id = $1', [id]);
      return { submission: submissions[0], testExecuted: false, message: 'Kod kaydedildi. Bu backend ortamında otomatik test çalıştırıcısı bulunmuyor.' };
    });
  }

  async evaluateTechnicalSession(
    id: string,
    body: {
      rubric: Array<{ questionId: string; scores: Record<string, number>; comment?: string }>;
      reviewerOverallScore?: number | null;
      reviewerNote?: string | null;
    },
  ) {
    if (!body || !Array.isArray(body.rubric) || body.rubric.length === 0 ||
        (body.reviewerOverallScore != null &&
          (typeof body.reviewerOverallScore !== 'number' || !Number.isFinite(body.reviewerOverallScore) || body.reviewerOverallScore < 0 || body.reviewerOverallScore > 100)) ||
        (body.reviewerNote != null && (typeof body.reviewerNote !== 'string' || body.reviewerNote.length > 8_000)) ||
        new Set(body.rubric.map((entry) => entry?.questionId)).size !== body.rubric.length) {
      throw new BadRequestException('Değerlendirme verileri geçersiz.');
    }
    return this.transaction(async (query) => {
      const sessions = await query<{ id: string; status: string; organizationId: string }>(
        'SELECT id, status, "organizationId" FROM "TechnicalInterviewSession" WHERE id = $1 FOR UPDATE', [id],
      );
      const session = sessions[0];
      if (!session) throw new NotFoundException('Teknik mülakat bulunamadı.');
      if (!['IN_PROGRESS', 'SUBMITTED', 'EVALUATED'].includes(session.status)) {
        throw new ConflictException('Bu mülakat değerlendirilemez.');
      }
      for (const entry of body.rubric) {
        if (!entry || typeof entry.questionId !== 'string' || !entry.scores ||
            typeof entry.scores !== 'object' || Array.isArray(entry.scores) ||
            (entry.comment !== undefined && (typeof entry.comment !== 'string' || entry.comment.length > 2_000))) {
          throw new BadRequestException('Rubric verileri geçersiz.');
        }
        const questions = await query<{ rubric: unknown }>(`
          SELECT q.rubric FROM "TechnicalInterviewQuestion" tiq
          INNER JOIN "TechnicalQuestion" q ON q.id = tiq."questionId"
          WHERE tiq."sessionId" = $1 AND tiq."questionId" = $2 AND q."organizationId" = $3
        `, [id, entry.questionId, session.organizationId]);
        if (!questions[0]) throw new NotFoundException('Rubric sorusu bu mülakata ait değil.');
        const submissions = await query<{ id: string }>(`
          SELECT id FROM "TechnicalSubmission"
          WHERE "sessionId" = $1 AND "questionId" = $2
          ORDER BY "submittedAt" DESC LIMIT 1
        `, [id, entry.questionId]);
        if (!submissions[0]) throw new ConflictException('Rubric için önce soru gönderimi gerekir.');
        const rubric = Array.isArray(questions[0].rubric) ? questions[0].rubric as Array<{ key?: unknown; weight?: unknown }> : [];
        const scores = Object.entries(entry.scores);
        if (scores.some(([key, score]) => !rubric.some((item) => item.key === key) ||
            typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 100)) {
          throw new BadRequestException('Rubric anahtarı veya puanı geçersiz.');
        }
        await query('DELETE FROM "TechnicalRubricScore" WHERE "submissionId" = $1 AND "reviewerOverride" = true', [submissions[0].id]);
        for (const [key, score] of scores) {
          const item = rubric.find((row) => row.key === key);
          await query(`
            INSERT INTO "TechnicalRubricScore" (id, "sessionId", "submissionId", "rubricKey", score, weight, comment, "reviewerOverride")
            VALUES ($1, $2, $3, $4, $5, $6, $7, true)
          `, [randomUUID(), id, submissions[0].id, key, score,
            typeof item?.weight === 'number' && Number.isFinite(item.weight) ? item.weight : 0,
            entry.comment?.trim() || null]);
        }
      }
      const questionRows = await query<{ questionId: string; difficulty: number; rubric: unknown }>(`
        SELECT q.id AS "questionId", q.difficulty, q.rubric
        FROM "TechnicalInterviewQuestion" tiq
        INNER JOIN "TechnicalQuestion" q ON q.id = tiq."questionId"
        WHERE tiq."sessionId" = $1 ORDER BY tiq."order"
      `, [id]);
      const latestSubmissions = await query<{ id: string; questionId: string }>(`
        SELECT DISTINCT ON ("questionId") id, "questionId"
        FROM "TechnicalSubmission" WHERE "sessionId" = $1
        ORDER BY "questionId", "submittedAt" DESC
      `, [id]);
      const scoreRows = await query<{ submissionId: string; rubricKey: string; score: number; reviewerOverride: boolean }>(`
        SELECT "submissionId", "rubricKey", score, "reviewerOverride"
        FROM "TechnicalRubricScore" WHERE "sessionId" = $1
      `, [id]);
      let weightedTotal = 0;
      let difficultyTotal = 0;
      let filled = 0;
      for (const question of questionRows) {
        const config = Array.isArray(question.rubric) ? question.rubric as Array<{ key?: unknown; weight?: unknown }> : [];
        const submission = latestSubmissions.find((item) => item.questionId === question.questionId);
        let scoreTotal = 0;
        let weightTotal = 0;
        let hasPositiveScore = false;
        for (const item of config) {
          if (typeof item.key !== 'string' || typeof item.weight !== 'number' || !Number.isFinite(item.weight)) continue;
          const matching = scoreRows.filter((row) => row.submissionId === submission?.id && row.rubricKey === item.key);
          const selected = matching.find((row) => row.reviewerOverride) ?? matching.find((row) => !row.reviewerOverride);
          const score = selected?.score ?? 0;
          if (score > 0) hasPositiveScore = true;
          scoreTotal += score * item.weight;
          weightTotal += item.weight;
        }
        if (hasPositiveScore) filled++;
        const difficultyWeight = 0.6 + question.difficulty * 0.1;
        weightedTotal += (weightTotal > 0 ? scoreTotal / weightTotal : 0) * difficultyWeight;
        difficultyTotal += difficultyWeight;
      }
      const overallScore = difficultyTotal > 0 ? weightedTotal / difficultyTotal : 0;
      const confidence = questionRows.length ? (filled / questionRows.length) * 100 : 0;
      const updated = await query(`
        UPDATE "TechnicalInterviewSession"
        SET status = 'EVALUATED', "evaluatedAt" = NOW(), "updatedAt" = NOW(),
          "reviewerOverallScore" = $2, "reviewerNote" = $3,
          "overallScore" = $4, confidence = $5
        WHERE id = $1
        RETURNING id, status, "evaluatedAt", "overallScore", confidence,
          "reviewerOverallScore", "reviewerNote"
      `, [id, body.reviewerOverallScore ?? null, body.reviewerNote?.trim() || null,
        overallScore, confidence]);
      return updated[0];
    });
  }

  async getInvites() {
    return this.query(`
      SELECT
        i.id,
        i.status,
        i."createdAt",
        i."sentAt",
        i."expiresAt",
        i."completedAt",
        c.id AS "candidateId",
        c."fullName" AS "candidateName",
        p.title AS "positionTitle"
      FROM "Invite" i
      INNER JOIN "Candidate" c
        ON c.id = i."candidateId"
        AND c."deletedAt" IS NULL
      LEFT JOIN "Position" p
        ON p.id = i."positionId"
      ORDER BY i."createdAt" DESC
    `);
  }

  async createEvaluationInvite(candidateId: string, organizationId: string, adminId: string) {
    if (!candidateId) throw new BadRequestException('Aday seçilmedi.');
    return this.transaction(async query => {
      const candidates = await query<{ id: string; fullName: string; email: string; positionId: string | null }>(
        'SELECT id, "fullName", email, "positionId" FROM "Candidate" WHERE id=$1 AND "organizationId"=$2 AND "deletedAt" IS NULL FOR UPDATE',
        [candidateId, organizationId],
      );
      const candidate = candidates[0];
      if (!candidate) throw new NotFoundException('Aday bulunamadı.');
      const existing = await query<{ id: string; status: string }>(
        `SELECT id, status FROM "Invite" WHERE "candidateId"=$1 AND "organizationId"=$2 AND status IN ('DRAFT','SENT','OPENED','EMAIL_VERIFIED','CONSENT_ACCEPTED','IN_PROGRESS','COMPLETED') AND "expiresAt">NOW() ORDER BY "createdAt" DESC LIMIT 1`,
        [candidateId, organizationId],
      );
      if (existing[0]) return { reused: true as const, status: existing[0].status, id: existing[0].id };
      const templates = await query<{ id: string; proctorPolicyId: string | null }>(
        'SELECT id, "proctorPolicyId" FROM "AssessmentTemplate" WHERE "organizationId"=$1 AND "isActive"=true ORDER BY "isDefault" DESC, "createdAt" ASC LIMIT 1',
        [organizationId],
      );
      const template = templates[0];
      if (!template) throw new BadRequestException('Aktif değerlendirme şablonu bulunamadı.');
      const token = randomBytes(32).toString('base64url');
      const hash = createHmac('sha256', process.env.INVITE_TOKEN_PEPPER ?? 'dev-invite-pepper-change-me-32-chars-min').update(token).digest('hex');
      const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000);
      const id = randomUUID();
      await query(
        `INSERT INTO "Invite" (id,"organizationId","candidateId","positionId","templateId","policyId","tokenHash","tokenLast4",status,"expiresAt","emailLanguage","createdById","createdAt","updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'DRAFT',$9,'tr',$10,NOW(),NOW())`,
        [id, organizationId, candidate.id, candidate.positionId, template.id, template.proctorPolicyId, hash, token.slice(-4), expiresAt, adminId],
      );
      return { reused: false as const, id, token, expiresAt, candidate };
    });
  }

  async markEvaluationInviteSent(id: string) {
    await this.query(`UPDATE "Invite" SET status='SENT', "sentAt"=NOW(), "updatedAt"=NOW() WHERE id=$1 AND status='DRAFT'`, [id]);
  }

  async discardUnsentEvaluationInvite(id: string) {
    await this.query(`DELETE FROM "Invite" WHERE id=$1 AND status='DRAFT'`, [id]);
  }

  private async findOtpInvite(
    query: <R = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<R[]>,
    token: string,
    lock = false,
  ) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new NotFoundException('Bağlantı bulunamadı.');
    const rows = await query<OtpInvite>(
      `SELECT i.id,i.status,i."expiresAt",i."organizationId",i."templateId",
              c."fullName" AS "candidateName",c.email AS "candidateEmail",
              t.name AS "templateName",t."durationSec"
       FROM "Invite" i JOIN "Candidate" c ON c.id=i."candidateId"
       JOIN "AssessmentTemplate" t ON t.id=i."templateId"
       WHERE i."tokenHash"=$1 AND c."deletedAt" IS NULL ${lock ? 'FOR UPDATE OF i' : ''}`,
      [inviteHash(token)],
    );
    if (!rows[0]) throw new NotFoundException('Bağlantı bulunamadı.');
    return rows[0];
  }

  private async checkOtpInvite(
    invite: OtpInvite,
  ) {
    if (invite.expiresAt < new Date() || ['EXPIRED', 'REVOKED', 'COMPLETED', 'INVALIDATED_BY_POLICY'].includes(invite.status)) {
      throw new BadRequestException('Bu davet bağlantısı artık geçerli değil.');
    }
  }

  async resolveEvaluationInvite(token: string) {
    return this.transaction(async query => {
      const invite = await this.findOtpInvite(query, token, true);
      if (invite.expiresAt < new Date() && !['EXPIRED', 'REVOKED', 'COMPLETED', 'INVALIDATED_BY_POLICY'].includes(invite.status)) {
        await query(`UPDATE "Invite" SET status='EXPIRED',"updatedAt"=NOW() WHERE id=$1`, [invite.id]);
        invite.status = 'EXPIRED';
      }
      if (['EXPIRED', 'REVOKED', 'COMPLETED', 'INVALIDATED_BY_POLICY'].includes(invite.status)) {
        return { closed: true, status: invite.status, candidateName: invite.status === 'COMPLETED' ? invite.candidateName : undefined };
      }
      if (['SENT', 'DRAFT'].includes(invite.status)) {
        await query(`UPDATE "Invite" SET status='OPENED',"openedAt"=COALESCE("openedAt",NOW()),"updatedAt"=NOW() WHERE id=$1`, [invite.id]);
        invite.status = 'OPENED';
      }
      const consents = await query<{ id: string; type: string; title: string; body: string; version: string; accepted: boolean }>(
        `SELECT d.id,d.type,d.title,d.body,d.version,(cc.id IS NOT NULL) AS accepted
         FROM "ConsentDocument" d LEFT JOIN "CandidateConsent" cc ON cc."documentId"=d.id AND cc."inviteId"=$1
         WHERE d."organizationId"=$2 AND d."isActive"=true AND d.language='tr'
         ORDER BY d.type,d."createdAt" DESC`, [invite.id, invite.organizationId],
      );
      return {
        closed: false,
        status: invite.status,
        candidateName: invite.candidateName,
        candidateEmailMasked: maskEmail(invite.candidateEmail),
        templateName: invite.templateName,
        durationSec: invite.durationSec,
        consents,
        emailVerified: ['EMAIL_VERIFIED', 'CONSENT_ACCEPTED', 'IN_PROGRESS'].includes(invite.status),
      };
    });
  }

  async createEvaluationEmailCode(token: string) {
    return this.transaction(async query => {
      const invite = await this.findOtpInvite(query, token, true);
      await this.checkOtpInvite(invite);
      if (!['OPENED', 'SENT', 'DRAFT'].includes(invite.status)) throw new ConflictException('E-posta doğrulama bu aşamada başlatılamaz.');
      const recent = await query<{ createdAt: Date }>(
        `SELECT "createdAt" FROM "EmailVerificationAttempt" WHERE "inviteId"=$1 AND "consumedAt" IS NULL ORDER BY "createdAt" DESC LIMIT 1`,
        [invite.id],
      );
      if (recent[0] && Date.now() - recent[0].createdAt.getTime() < 30_000) {
        throw new ConflictException('Lütfen yeni kod istemeden önce 30 saniye bekleyin.');
      }
      const code = String(randomInt(0, 10 ** otpLength)).padStart(otpLength, '0');
      const salt = randomBytes(8).toString('hex');
      const attemptId = randomUUID();
      await query(
        `INSERT INTO "EmailVerificationAttempt" (id,"inviteId","codeHash","expiresAt",attempts,"createdAt") VALUES ($1,$2,$3,$4,0,NOW())`,
        [attemptId, invite.id, `${salt}.${otpHash(code, salt)}`, new Date(Date.now() + otpTtlMs)],
      );
      return { attemptId, code, candidateName: invite.candidateName, candidateEmail: invite.candidateEmail, sentTo: maskEmail(invite.candidateEmail), ttlMs: otpTtlMs };
    });
  }

  async discardEvaluationEmailCode(attemptId: string) {
    await this.query(`DELETE FROM "EmailVerificationAttempt" WHERE id=$1 AND "consumedAt" IS NULL`, [attemptId]);
  }

  async verifyEvaluationEmailCode(token: string, code: string) {
    if (!/^\d{6}$/.test(code)) throw new BadRequestException('Altı haneli doğrulama kodu girin.');
    const result = await this.transaction(async query => {
      const invite = await this.findOtpInvite(query, token, true);
      await this.checkOtpInvite(invite);
      if (!['OPENED', 'SENT', 'DRAFT'].includes(invite.status)) throw new ConflictException('E-posta doğrulama bu aşamada yapılamaz.');
      const attempts = await query<{ id: string; codeHash: string; expiresAt: Date; attempts: number }>(
        `SELECT id,"codeHash","expiresAt",attempts FROM "EmailVerificationAttempt" WHERE "inviteId"=$1 AND "consumedAt" IS NULL ORDER BY "createdAt" DESC LIMIT 1 FOR UPDATE`,
        [invite.id],
      );
      const attempt = attempts[0];
      if (!attempt) throw new BadRequestException('Önce kod talep edin.');
      if (attempt.expiresAt < new Date()) throw new BadRequestException('Kod süresi doldu.');
      if (attempt.attempts >= otpMaxAttempts) throw new ForbiddenException('Çok fazla yanlış deneme. Yeni kod isteyin.');
      const [salt, expected] = attempt.codeHash.split('.');
      const provided = otpHash(code, salt);
      const valid = !!expected && timingSafeEqual(Buffer.from(provided, 'hex'), Buffer.from(expected, 'hex'));
      if (!valid) {
        await query(`UPDATE "EmailVerificationAttempt" SET attempts=attempts+1 WHERE id=$1`, [attempt.id]);
        return { ok: false };
      }
      await query(`UPDATE "EmailVerificationAttempt" SET "consumedAt"=NOW() WHERE id=$1`, [attempt.id]);
      await query(`UPDATE "Invite" SET status='EMAIL_VERIFIED',"updatedAt"=NOW() WHERE id=$1`, [invite.id]);
      return { ok: true };
    });
    if (!result.ok) throw new BadRequestException('Kod hatalı.');
    return result;
  }

  async acceptEvaluationConsents(token: string, documentIds: string[], ip?: string, userAgent?: string) {
    if (!Array.isArray(documentIds) || !documentIds.length || new Set(documentIds).size !== documentIds.length) {
      throw new BadRequestException('Geçerli onayları seçin.');
    }
    return this.transaction(async query => {
      const invite = await this.findOtpInvite(query, token, true);
      await this.checkOtpInvite(invite);
      if (!['EMAIL_VERIFIED', 'CONSENT_ACCEPTED'].includes(invite.status)) {
        throw new ConflictException('Önce e-posta adresinizi doğrulayın.');
      }
      const documents = await query<{ id: string }>(
        `SELECT id FROM "ConsentDocument" WHERE "organizationId"=$1 AND "isActive"=true AND language='tr'`,
        [invite.organizationId],
      );
      if (!documents.length || documents.length !== documentIds.length ||
          documents.some(document => !documentIds.includes(document.id))) {
        throw new BadRequestException('Eksik veya geçersiz onay.');
      }
      for (const document of documents) {
        await query(
          `INSERT INTO "CandidateConsent" (id,"inviteId","documentId","acceptedAt",ip,"userAgent")
           VALUES ($1,$2,$3,NOW(),$4,$5)
           ON CONFLICT ("inviteId","documentId") DO UPDATE SET "acceptedAt"=NOW(),ip=EXCLUDED.ip,"userAgent"=EXCLUDED."userAgent"`,
          [randomUUID(), invite.id, document.id, ip ?? null, userAgent ?? null],
        );
      }
      await query(`UPDATE "Invite" SET status='CONSENT_ACCEPTED',"updatedAt"=NOW() WHERE id=$1`, [invite.id]);
      return { ok: true };
    });
  }

  private async serializeEvaluationSession(
    query: <R = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<R[]>,
    session: { id: string; startedAt: Date; inviteId: string },
    invite: OtpInvite,
  ) {
    const sections = await query<{ id: string; title: string; description: string | null; order: number }>(
      `SELECT id,title,description,"order" FROM "AssessmentSection" WHERE "templateId"=$1 ORDER BY "order" ASC`,
      [invite.templateId],
    );
    const questions = sections.length ? await query<{ sectionId: string; id: string; type: string; prompt: string; helpText: string | null }>(
      `SELECT sq."sectionId",q.id,q.type,q.prompt,q."helpText"
       FROM "SectionQuestion" sq JOIN "Question" q ON q.id=sq."questionId"
       WHERE sq."sectionId"=ANY($1::text[]) ORDER BY sq."order" ASC`,
      [sections.map(section => section.id)],
    ) : [];
    const options = questions.length ? await query<{ id: string; questionId: string; label: string; value: string; order: number }>(
      `SELECT id,"questionId",label,value,"order" FROM "QuestionOption"
       WHERE "questionId"=ANY($1::text[]) ORDER BY "order" ASC`,
      [[...new Set(questions.map(question => question.id))]],
    ) : [];
    const answers = await query<{ questionId: string; rawValue: AnswerValue }>(
      `SELECT "questionId","rawValue" FROM "CandidateAnswer" WHERE "sessionId"=$1`, [session.id],
    );
    return {
      sessionId: session.id,
      durationSec: invite.durationSec,
      startedAt: session.startedAt.toISOString(),
      sections: sections.map(section => ({
        ...section,
        questions: questions.filter(question => question.sectionId === section.id).map(question => ({
          id: question.id, type: question.type, prompt: question.prompt, helpText: question.helpText,
          options: options.filter(option => option.questionId === question.id).map(option => ({
            id: option.id, label: option.label, value: option.value, order: option.order,
          })),
        })),
      })),
      alreadyAnswered: Object.fromEntries(answers.map(answer => [answer.questionId, answer.rawValue])),
      policy: unrestrictedPolicy,
    };
  }

  async startEvaluationSession(
    token: string,
    input: { fullscreenAtStart?: boolean; screen?: { width: number; height: number } },
    ip?: string,
    userAgent?: string,
  ) {
    return this.transaction(async query => {
      const invite = await this.findOtpInvite(query, token, true);
      await this.checkOtpInvite(invite);
      if (!['CONSENT_ACCEPTED', 'IN_PROGRESS'].includes(invite.status)) {
        throw new ConflictException('Önce e-posta doğrulayın ve onayları kabul edin.');
      }
      const sessions = await query<{ id: string; stage: string; startedAt: Date; inviteId: string }>(
        `SELECT id,stage,"startedAt","inviteId" FROM "CandidateSession" WHERE "inviteId"=$1 FOR UPDATE`, [invite.id],
      );
      let session = sessions[0];
      if (session?.stage === 'CLOSED' || session?.stage === 'SUBMITTED') throw new ConflictException('Oturum kapatılmış.');
      if (!session) {
        if (invite.status !== 'CONSENT_ACCEPTED') throw new ConflictException('Oturum bulunamadı.');
        const id = randomUUID();
        const screenW = input?.screen?.width;
        const screenH = input?.screen?.height;
        if ((screenW != null && (!Number.isInteger(screenW) || screenW < 0 || screenW > 20000)) ||
            (screenH != null && (!Number.isInteger(screenH) || screenH < 0 || screenH > 20000))) {
          throw new BadRequestException('Ekran boyutu geçersiz.');
        }
        const created = await query<{ id: string; stage: string; startedAt: Date; inviteId: string }>(
          `INSERT INTO "CandidateSession"
           (id,"inviteId",stage,"startedAt","timeRemainingMs",ip,"userAgent","screenW","screenH","fullscreenAtStart","lastHeartbeatAt","createdAt","updatedAt")
           VALUES ($1,$2,'ASSESSMENT',NOW(),$3,$4,$5,$6,$7,$8,NOW(),NOW(),NOW())
           RETURNING id,stage,"startedAt","inviteId"`,
          [id, invite.id, invite.durationSec * 1000, ip ?? null, userAgent ?? null, screenW ?? null, screenH ?? null, !!input?.fullscreenAtStart],
        );
        session = created[0];
        await query(`UPDATE "Invite" SET status='IN_PROGRESS',"startedAt"=NOW(),"updatedAt"=NOW() WHERE id=$1`, [invite.id]);
      }
      return this.serializeEvaluationSession(query, session, invite);
    });
  }

  async saveEvaluationAnswer(
    sessionId: string,
    input: { questionId: string; value: AnswerValue; timeSpentMs?: number },
  ) {
    const value = input?.value;
    if (!input?.questionId || !value || !['likert', 'choice', 'rank', 'text'].includes(value.type)) {
      throw new BadRequestException('Cevap geçersiz.');
    }
    const timeSpentMs = input.timeSpentMs ?? 0;
    if (!Number.isInteger(timeSpentMs) || timeSpentMs < 0 || timeSpentMs > 3_600_000) {
      throw new BadRequestException('Cevap süresi geçersiz.');
    }
    return this.transaction(async query => {
      const sessions = await query<{ inviteId: string; status: string; templateId: string }>(
        `SELECT s."inviteId",i.status,i."templateId" FROM "CandidateSession" s
         JOIN "Invite" i ON i.id=s."inviteId" WHERE s.id=$1 FOR UPDATE OF s`, [sessionId],
      );
      const session = sessions[0];
      if (!session) throw new NotFoundException('Oturum bulunamadı.');
      if (session.status !== 'IN_PROGRESS') throw new ConflictException('Bu oturum aktif değil.');
      const questions = await query<{ type: string }>(
        `SELECT q.type FROM "SectionQuestion" sq JOIN "AssessmentSection" sec ON sec.id=sq."sectionId"
         JOIN "Question" q ON q.id=sq."questionId"
         WHERE sec."templateId"=$1 AND q.id=$2 LIMIT 1`, [session.templateId, input.questionId],
      );
      const type = questions[0]?.type;
      if (!type || (type === 'LIKERT' && value.type !== 'likert') ||
          ((type === 'MULTIPLE_CHOICE' || type === 'SCENARIO_CHOICE') && value.type !== 'choice') ||
          (type === 'PRIORITY_RANK' && value.type !== 'rank') ||
          (type === 'SHORT_TEXT' && value.type !== 'text')) {
        throw new BadRequestException('Soru veya cevap tipi geçersiz.');
      }
      if ((value.type === 'likert' && (!Number.isInteger(value.value) || value.value < 1 || value.value > 7)) ||
          (value.type === 'choice' && (typeof value.value !== 'string' || !value.value || value.value.length > 80)) ||
          (value.type === 'rank' && (!Array.isArray(value.value) || value.value.length < 2 || value.value.length > 20 || value.value.some(item => typeof item !== 'string'))) ||
          (value.type === 'text' && (typeof value.value !== 'string' || value.value.length > 4000))) {
        throw new BadRequestException('Cevap değeri geçersiz.');
      }
      await query(
        `INSERT INTO "CandidateAnswer" (id,"sessionId","questionId","rawValue","timeSpentMs","createdAt","updatedAt")
         VALUES ($1,$2,$3,$4::jsonb,$5,NOW(),NOW())
         ON CONFLICT ("sessionId","questionId") DO UPDATE SET "rawValue"=EXCLUDED."rawValue","timeSpentMs"=EXCLUDED."timeSpentMs","updatedAt"=NOW()`,
        [randomUUID(), sessionId, input.questionId, JSON.stringify(value), timeSpentMs],
      );
      return { ok: true };
    });
  }

  async recordEvaluationProctorEvent(
    sessionId: string,
    input: { type: string; occurredAt: string; durationMs?: number; metadata?: Record<string, unknown> },
  ) {
    const allowed = ['TAB_HIDDEN', 'WINDOW_BLUR', 'FULLSCREEN_EXIT', 'PAGE_LEAVE_ATTEMPT', 'COPY', 'PASTE', 'CONTEXT_MENU', 'DEVTOOLS_OPEN', 'PASTE_BLOCKED', 'RESUMED', 'HEARTBEAT', 'CUSTOM'];
    const occurredAt = new Date(input?.occurredAt);
    if (!allowed.includes(input?.type) || Number.isNaN(occurredAt.getTime()) ||
        (input.durationMs != null && (!Number.isInteger(input.durationMs) || input.durationMs < 0))) {
      throw new BadRequestException('Oturum olayı geçersiz.');
    }
    return this.transaction(async query => {
      const sessions = await query<{ status: string }>(
        `SELECT i.status FROM "CandidateSession" s JOIN "Invite" i ON i.id=s."inviteId" WHERE s.id=$1 FOR UPDATE OF s`,
        [sessionId],
      );
      if (!sessions[0]) throw new NotFoundException('Oturum bulunamadı.');
      if (sessions[0].status !== 'IN_PROGRESS') throw new ConflictException('Bu oturum aktif değil.');
      const id = randomUUID();
      await query(
        `INSERT INTO "ProctorEvent" (id,"sessionId",type,"occurredAt","durationMs",metadata,"isViolation")
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)`,
        [id, sessionId, input.type, occurredAt, input.durationMs ?? null,
          JSON.stringify(input.metadata ?? {}), ['TAB_HIDDEN', 'WINDOW_BLUR', 'FULLSCREEN_EXIT', 'PAGE_LEAVE_ATTEMPT'].includes(input.type)],
      );
      return { ok: true, decision: 'OK', eventId: id };
    });
  }

  async heartbeatEvaluationSession(sessionId: string) {
    const rows = await this.query(
      `UPDATE "CandidateSession" s SET "lastHeartbeatAt"=NOW(),"updatedAt"=NOW()
       FROM "Invite" i WHERE s.id=$1 AND i.id=s."inviteId" AND i.status='IN_PROGRESS' RETURNING s.id`,
      [sessionId],
    );
    if (!rows.length) throw new NotFoundException('Aktif oturum bulunamadı.');
    return { ok: true };
  }

  async submitEvaluationSession(sessionId: string) {
    return this.transaction(async query => {
      const sessions = await query<{ inviteId: string; status: string; templateId: string }>(
        `SELECT s."inviteId",i.status,i."templateId" FROM "CandidateSession" s
         JOIN "Invite" i ON i.id=s."inviteId" WHERE s.id=$1 FOR UPDATE OF s,i`,
        [sessionId],
      );
      const session = sessions[0];
      if (!session) throw new NotFoundException('Oturum bulunamadı.');
      if (session.status !== 'IN_PROGRESS') throw new ConflictException('Aktif değerlendirme oturumu bulunamadı.');
      const questions = await query<{ id: string; type: ScoringQuestion['type']; reverseScored: boolean }>(
        `SELECT q.id,q.type,q."reverseScored" FROM "SectionQuestion" sq
         JOIN "AssessmentSection" sec ON sec.id=sq."sectionId"
         JOIN "Question" q ON q.id=sq."questionId"
         WHERE sec."templateId"=$1 ORDER BY sec."order",sq."order"`,
        [session.templateId],
      );
      if (!questions.length) throw new BadRequestException('Değerlendirme şablonunda soru bulunamadı.');
      const answers = await query<{ questionId: string; rawValue: AnswerValue }>(
        `SELECT "questionId","rawValue" FROM "CandidateAnswer" WHERE "sessionId"=$1`, [sessionId],
      );
      const answersById = Object.fromEntries(answers.map(answer => [answer.questionId, answer.rawValue]));
      const missing = questions.filter(question =>
        ['LIKERT', 'MULTIPLE_CHOICE', 'SCENARIO_CHOICE'].includes(question.type) && !answersById[question.id],
      );
      if (missing.length) throw new BadRequestException(`${missing.length} zorunlu soru cevaplanmadı.`);
      const ids = [...new Set(questions.map(question => question.id))];
      const options = await query<{ questionId: string; value: string; score: number; order: number }>(
        `SELECT "questionId",value,score,"order" FROM "QuestionOption"
         WHERE "questionId"=ANY($1::text[]) ORDER BY "order"`, [ids],
      );
      const weights = await query<{ questionId: string; dimension: string; weight: number }>(
        `SELECT "questionId",dimension,weight FROM "QuestionDimensionWeight" WHERE "questionId"=ANY($1::text[])`, [ids],
      );
      const scoringQuestions: ScoringQuestion[] = questions.map(question => ({
        id: question.id, type: question.type, reverseScored: question.reverseScored,
        options: options.filter(option => option.questionId === question.id).map(option => ({
          value: option.value, score: option.score, order: option.order,
        })),
        dimensions: weights.filter(weight => weight.questionId === question.id).map(weight => ({
          dimension: weight.dimension, weight: weight.weight,
        })),
      }));
      const result = scoreAssessment(scoringQuestions, answersById);
      const existing = await query<{ id: string }>(`SELECT id FROM "AssessmentResult" WHERE "inviteId"=$1 FOR UPDATE`, [session.inviteId]);
      const resultId = existing[0]?.id ?? randomUUID();
      if (existing.length) {
        await query(
          `UPDATE "AssessmentResult" SET "consistencyScore"=$2,"rawScores"=$3::jsonb,
           "followUpQuestions"=$4,"updatedAt"=NOW() WHERE id=$1`,
          [resultId, result.consistencyScore, JSON.stringify(result), result.followUpQuestions],
        );
      } else {
        await query(
          `INSERT INTO "AssessmentResult"
           (id,"inviteId","consistencyScore","rawScores","followUpQuestions","completedAt","createdAt","updatedAt")
           VALUES ($1,$2,$3,$4::jsonb,$5,NOW(),NOW(),NOW())`,
          [resultId, session.inviteId, result.consistencyScore, JSON.stringify(result), result.followUpQuestions],
        );
      }
      await query(`DELETE FROM "DimensionScore" WHERE "resultId"=$1`, [resultId]);
      for (const [dimension, score] of Object.entries(result.dimensionScores)) {
        const label = DIMENSIONS.find(item => item.key === dimension)?.label ?? dimension;
        const observation = score >= 75 ? `${label}: aday bu boyutta belirgin pozitif sinyal gösterdi. Görüşmede güçlü yanları doğrulayın.`
          : score >= 50 ? `${label}: dengeli profil. Görüşmede somut örneklerle derinleşin.`
          : score >= 30 ? `${label}: gözlemler karışık. Yapılandırılmış soru ile düşük çıkan bağlamı netleştirin.`
          : `${label}: bu boyutta sinyaller sınırlı. Kararı görüşme verisine dayandırın; otomatik eleme yapmayın.`;
        await query(
          `INSERT INTO "DimensionScore" (id,"resultId",dimension,score,observation) VALUES ($1,$2,$3,$4,$5)`,
          [randomUUID(), resultId, dimension, score, observation],
        );
      }
      await query(`UPDATE "CandidateSession" SET stage='SUBMITTED',"endedAt"=NOW(),"updatedAt"=NOW() WHERE id=$1`, [sessionId]);
      await query(`UPDATE "Invite" SET status='COMPLETED',"completedAt"=NOW(),"updatedAt"=NOW() WHERE id=$1`, [session.inviteId]);
      return { ok: true, resultId };
    });
  }

  async getCalendarAppointments() {
    return this.query(`
      SELECT
        aps.id,
        aps."startAt",
        aps."isBooked",
        ab.id AS "bookingId",
        ab."createdAt" AS "bookingCreatedAt",
        c.id AS "candidateId",
        c."fullName" AS "candidateName",
        c.email AS "candidateEmail",
        c.phone AS "candidatePhone",
        p.id AS "positionId",
        p.title AS "positionTitle"
      FROM "AppointmentSlot" aps
      LEFT JOIN "AppointmentBooking" ab
        ON ab."slotId" = aps.id
      LEFT JOIN "Candidate" c
        ON c.id = ab."candidateId"
        AND c."deletedAt" IS NULL
      LEFT JOIN "Position" p
        ON p.id = c."positionId"
      ORDER BY aps."startAt" ASC
    `);
  }

  private async appointmentOrganizationId(): Promise<string> {
    const rows = await this.query<{ id: string }>('SELECT id FROM "Organization" ORDER BY id LIMIT 2');
    if (rows.length !== 1) throw new ConflictException('Randevu yönetimi için tek organizasyon bağlamı gerekli.');
    return rows[0].id;
  }

  async getAppointmentSlots() {
    const organizationId = await this.appointmentOrganizationId();
    return this.query(`SELECT s.id, s."startAt", s."isBooked", c."fullName" AS "candidateName"
      FROM "AppointmentSlot" s LEFT JOIN "AppointmentBooking" b ON b."slotId" = s.id
      LEFT JOIN "Candidate" c ON c.id = b."candidateId"
      WHERE s."organizationId" = $1 ORDER BY s."startAt"`, [organizationId]);
  }

  async createAppointmentSlots(body: { dates: string[]; times: string[] }) {
    if (!Array.isArray(body?.dates) || !Array.isArray(body?.times) || !body.dates.length || !body.times.length)
      throw new BadRequestException('Gün ve saat seçiniz.');
    const organizationId = await this.appointmentOrganizationId();
    const starts = new Set<string>();
    for (const date of body.dates) for (const time of body.times) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^(10|11|12|13|14|15|16|17):00$/.test(time))
        throw new BadRequestException('Geçerli bir gün ve 10:00–17:00 arası saat seçiniz.');
      const start = new Date(`${date}T${time}:00+03:00`);
      if (Number.isNaN(start.getTime()) || start <= new Date() || start.toLocaleDateString('en-CA', { timeZone: 'Europe/Istanbul' }) !== date)
        throw new BadRequestException('Yalnızca gelecek tarihler seçilebilir.');
      starts.add(start.toISOString());
    }
    return this.transaction(async query => {
      let created = 0;
      for (const start of starts) {
        const rows = await query('SELECT id FROM "AppointmentSlot" WHERE "organizationId"=$1 AND "startAt"=$2 LIMIT 1', [organizationId, start]);
        if (rows.length) continue;
        await query('INSERT INTO "AppointmentSlot" (id,"organizationId","startAt") VALUES ($1,$2,$3)', [randomUUID(), organizationId, start]);
        created++;
      }
      return { created };
    });
  }

  async deleteAppointmentSlot(id: string) {
    const organizationId = await this.appointmentOrganizationId();
    return this.transaction(async query => {
      const rows = await query<{ isBooked: boolean }>('SELECT "isBooked" FROM "AppointmentSlot" WHERE id=$1 AND "organizationId"=$2 FOR UPDATE', [id, organizationId]);
      if (!rows.length) throw new NotFoundException('Saat bulunamadı.');
      if (rows[0].isBooked) throw new ConflictException('Rezerve saat silinemez.');
      await query('DELETE FROM "AppointmentSlot" WHERE id=$1', [id]);
      return { ok: true };
    });
  }

  async createAppointmentInvite(candidateId: string) {
    return this.transaction(async query => {
      const candidates = await query<{ id: string; organizationId: string; tags: string[] }>(
        'SELECT id,"organizationId",tags FROM "Candidate" WHERE id=$1 AND "deletedAt" IS NULL FOR UPDATE', [candidateId]);
      if (!candidates.length) throw new NotFoundException('Aday bulunamadı.');
      if (candidates[0].tags?.includes('Reddedildi')) throw new ConflictException('Reddedilen adaya davet oluşturulamaz.');
      const booked = await query('SELECT id FROM "AppointmentInvite" WHERE "candidateId"=$1 AND status=$2 LIMIT 1', [candidateId, 'BOOKED']);
      if (booked.length) throw new ConflictException('Adayın zaten bir randevusu var.');
      const existing = await query<{ token: string; expiresAt: Date }>(
        'SELECT token,"expiresAt" FROM "AppointmentInvite" WHERE "candidateId"=$1 AND status=$2 AND "expiresAt">NOW() ORDER BY "sentAt" DESC LIMIT 1', [candidateId, 'PENDING']);
      if (existing.length) return { token: existing[0].token, expiresAt: existing[0].expiresAt, reused: true };
      const free = await query('SELECT id FROM "AppointmentSlot" WHERE "organizationId"=$1 AND "isBooked"=false AND "startAt">NOW() LIMIT 1', [candidates[0].organizationId]);
      if (!free.length) throw new BadRequestException('Önce Randevular sayfasında müsait saat oluşturun.');
      const token = randomBytes(24).toString('base64url');
      const expiresAt = new Date(Date.now() + 7 * 86400000);
      await query('INSERT INTO "AppointmentInvite" (id,"organizationId",token,"candidateId","expiresAt") VALUES ($1,$2,$3,$4,$5)',
        [randomUUID(), candidates[0].organizationId, token, candidateId, expiresAt]);
      return { token, expiresAt, reused: false };
    });
  }

  async getCandidateMailContact(id: string, organizationId: string) {
    const rows = await this.query<{ fullName: string; email: string }>(
      'SELECT "fullName",email FROM "Candidate" WHERE id=$1 AND "organizationId"=$2 AND "deletedAt" IS NULL LIMIT 1',
      [id, organizationId],
    );
    if (!rows.length) throw new NotFoundException('Aday bulunamadı.');
    return rows[0];
  }

  async rejectCandidate(id: string, organizationId: string) {
    return this.transaction(async query => {
      const rows = await query<{ id: string; tags: string[] }>(
        'SELECT id,tags FROM "Candidate" WHERE id=$1 AND "organizationId"=$2 AND "deletedAt" IS NULL FOR UPDATE', [id, organizationId]);
      if (!rows.length) throw new NotFoundException('Aday bulunamadı.');
      if (rows[0].tags?.includes('Reddedildi')) return { ...rows[0], alreadyRejected: true };
      const updated = await query<{ id: string; tags: string[] }>(
        `UPDATE "Candidate" SET tags=array_append(COALESCE(tags, ARRAY[]::text[]), 'Reddedildi') WHERE id=$1 RETURNING id,tags`, [id]);
      return { ...updated[0], alreadyRejected: false };
    });
  }

  async resolveAppointmentInvite(token: string) {
    const rows = await this.query<{ id: string; organizationId: string; status: string; expiresAt: Date | null; candidateName: string; startAt: Date | null }>(
      `SELECT i.id,i."organizationId",i.status,i."expiresAt",c."fullName" AS "candidateName",s."startAt"
       FROM "AppointmentInvite" i JOIN "Candidate" c ON c.id=i."candidateId"
       LEFT JOIN "AppointmentBooking" b ON b."inviteId"=i.id LEFT JOIN "AppointmentSlot" s ON s.id=b."slotId"
       WHERE i.token=$1 AND c."deletedAt" IS NULL`, [token]);
    if (!rows.length) throw new NotFoundException('Davet bulunamadı.');
    const invite = rows[0];
    if (invite.expiresAt && invite.expiresAt < new Date()) throw new BadRequestException('Davet bağlantısının süresi doldu.');
    if (invite.status === 'CANCELLED') throw new BadRequestException('Davet iptal edilmiş.');
    if (invite.status === 'BOOKED') return { candidateName: invite.candidateName, alreadyBooked: true, startAt: invite.startAt, slots: [] };
    const slots = await this.query('SELECT id,"startAt" FROM "AppointmentSlot" WHERE "organizationId"=$1 AND "isBooked"=false AND "startAt">NOW() ORDER BY "startAt"', [invite.organizationId]);
    return { candidateName: invite.candidateName, alreadyBooked: false, slots };
  }

  async bookAppointment(token: string, slotId: string) {
    if (!slotId) throw new BadRequestException('Saat seçiniz.');
    return this.transaction(async query => {
      const invites = await query<{ id: string; organizationId: string; candidateId: string; status: string; expiresAt: Date | null }>(
        'SELECT id,"organizationId","candidateId",status,"expiresAt" FROM "AppointmentInvite" WHERE token=$1 FOR UPDATE', [token]);
      if (!invites.length) throw new NotFoundException('Davet bulunamadı.');
      const invite = invites[0];
      if (invite.expiresAt && invite.expiresAt < new Date()) throw new BadRequestException('Davet bağlantısının süresi doldu.');
      if (invite.status !== 'PENDING') throw new ConflictException('Bu davetle rezervasyon yapılamaz.');
      const slots = await query<{ startAt: Date }>(
        'UPDATE "AppointmentSlot" SET "isBooked"=true WHERE id=$1 AND "organizationId"=$2 AND "isBooked"=false AND "startAt">NOW() RETURNING "startAt"',
        [slotId, invite.organizationId]);
      if (!slots.length) throw new ConflictException('Seçilen saat artık müsait değil.');
      await query('INSERT INTO "AppointmentBooking" (id,"slotId","inviteId","candidateId") VALUES ($1,$2,$3,$4)',
        [randomUUID(), slotId, invite.id, invite.candidateId]);
      await query('UPDATE "AppointmentInvite" SET status=$2 WHERE id=$1', [invite.id, 'BOOKED']);
      return { ok: true, startAt: slots[0].startAt };
    });
  }

  async createCandidate(
  data: {
    fullName?: string;
    email?: string;
    phone?: string;
    birthDate?: string | null;
    district?: string | null;
    militaryStatus?: string | null;
    hasDriverLicense?: boolean | null;
    driverLicenseType?: string | null;
    activelyDriving?: boolean | null;
    positionId?: string | null;
    source?: string | null;
    foreignLanguage?: string | null;
    totalWorkExperience?: string | null;
    field?: string | null;
  },
  organizationId: string,
) {
  const candidateId = randomUUID();

  const fullName = data.fullName?.trim() || 'İsimsiz Aday';
  const email =
    data.email?.trim() ||
    `manual-${candidateId}@no-email.local`;

  const rows = await this.query(
    `
      INSERT INTO "Candidate" (
        id,
        "organizationId",
        "fullName",
        email,
        phone,
        "birthDate",
        district,
        "militaryStatus",
        "hasDriverLicense",
        "driverLicenseType",
        "activelyDriving",
        "positionId",
        source,
        "foreignLanguage",
        "totalWorkExperience",
        field,
        "createdAt",
        "updatedAt"
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8,
        $9, $10, $11, $12, $13, $14, $15, $16,
        NOW(), NOW()
      )
      RETURNING
        id,
        "fullName",
        email,
        phone,
        "birthDate",
        district,
        "militaryStatus",
        "hasDriverLicense",
        "driverLicenseType",
        "activelyDriving",
        "positionId",
        source,
        "foreignLanguage",
        "totalWorkExperience",
        field,
        "createdAt"
    `,
    [
      candidateId,
      organizationId,
      fullName,
      email,
      data.phone?.trim() || null,
      data.birthDate || null,
      data.district || null,
      data.militaryStatus || null,
      data.hasDriverLicense ?? null,
      data.driverLicenseType || null,
      data.activelyDriving ?? null,
      data.positionId || null,
      data.source || null,
      data.foreignLanguage || null,
      data.totalWorkExperience || null,
      data.field || null,
    ],
  );

  return rows[0];
}
  // UPDATE

  async updateCandidateScore(
    id: string,
    score: number | null,
  ) {
    const rows = await this.query(
      `
      UPDATE "Candidate"
      SET score = $2
      WHERE id = $1
        AND "deletedAt" IS NULL
      RETURNING id, score
      `,
      [id, score],
    );

    return rows[0] ?? null;
  }

  async updateCandidate(
    id: string,
    data: Record<string, any>,
  ) {
    const allowedFields = [
      "fullName",
      "email",
      "phone",
      "district",
      "militaryStatus",
      "hasDriverLicense",
      "driverLicenseType",
      "activelyDriving",
      "field",
      "totalWorkExperience",
      "foreignLanguage",
      "notes",
    ];

    const updates: string[] = [];
    const values: any[] = [];

    for (const field of allowedFields) {
      if (Object.prototype.hasOwnProperty.call(data, field)) {
        updates.push(`"${field}" = $${values.length + 2}`);
        values.push(data[field]);
      }
    }

    if (updates.length === 0) {
      return null;
    }

    const rows = await this.query(
      `
      UPDATE "Candidate"
      SET ${updates.join(", ")}
      WHERE id = $1
        AND "deletedAt" IS NULL
      RETURNING
        id,
        "fullName",
        email,
        phone,
        district,
        "militaryStatus",
        "hasDriverLicense",
        "driverLicenseType",
        "activelyDriving",
        field,
        "totalWorkExperience",
        "foreignLanguage",
        notes
      `,
      [id, ...values],
    );

    return rows[0] ?? null;
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}
