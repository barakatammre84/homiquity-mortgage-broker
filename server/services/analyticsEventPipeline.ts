import { db } from "../db";
import {
  analyticsEvents,
  type AnalyticsDomain,
  type InsertAnalyticsEvent,
} from "@shared/schema";
import { eq, and, gte, lte, sql, desc, count } from "drizzle-orm";
import type { DatabaseTransaction } from "./documentLineage";

export async function emitEvent(
  domain: AnalyticsDomain,
  eventName: string,
  options: {
    applicationId?: string;
    userId?: string;
    actorId?: string;
    actorRole?: string;
    entityType?: string;
    entityId?: string;
    payload?: Record<string, any>;
    numericValue?: number;
    textValue?: string;
    previousValue?: any;
    newValue?: any;
    source?: string;
    automationTriggered?: boolean;
  } = {},
  transaction: DatabaseTransaction | typeof db = db,
): Promise<void> {
  try {
    await transaction.insert(analyticsEvents).values({
      domain,
      eventName,
      applicationId: options.applicationId || null,
      userId: options.userId || null,
      actorId: options.actorId || null,
      actorRole: options.actorRole || null,
      entityType: options.entityType || null,
      entityId: options.entityId || null,
      payload: options.payload || null,
      numericValue: options.numericValue?.toString() || null,
      textValue: options.textValue || null,
      previousValue: options.previousValue || null,
      newValue: options.newValue || null,
      source: options.source || "system",
      automationTriggered: options.automationTriggered || false,
    });
  } catch (error) {
    console.error(`[AnalyticsPipeline] Failed to emit event ${domain}.${eventName}:`, error);
  }
}

export function emitUnderwritingDecision(applicationId: string, decision: string, actorId: string, actorRole: string, details?: Record<string, any>) {
  return emitEvent("underwriting", "decision_made", {
    applicationId,
    actorId,
    actorRole,
    textValue: decision,
    payload: details,
  });
}

export function emitStageTransition(applicationId: string, fromStage: string, toStage: string, actorId?: string, automated = false) {
  return emitEvent("pipeline", "stage_transition", {
    applicationId,
    actorId,
    previousValue: { stage: fromStage },
    newValue: { stage: toStage },
    automationTriggered: automated,
  });
}

export function emitDocumentProcessed(documentId: string, documentType: string, applicationId: string | undefined, confidence: number, fieldsExtracted: number) {
  return emitEvent("document", "extraction_completed", {
    applicationId,
    entityType: "document",
    entityId: documentId,
    numericValue: confidence,
    payload: { documentType, fieldsExtracted },
    automationTriggered: true,
    source: "ai_extraction",
  });
}

export function emitComplianceCheck(applicationId: string, checkName: string, passed: boolean, details?: Record<string, any>) {
  return emitEvent("compliance", "check_completed", {
    applicationId,
    textValue: checkName,
    payload: { passed, ...details },
    automationTriggered: true,
  });
}

export function emitConditionUpdate(applicationId: string, conditionId: string, action: string, actorId: string, actorRole: string) {
  return emitEvent("underwriting", "condition_updated", {
    applicationId,
    actorId,
    actorRole,
    entityType: "condition",
    entityId: conditionId,
    textValue: action,
  });
}

export function emitBorrowerAction(userId: string, action: string, applicationId?: string, details?: Record<string, any>) {
  return emitEvent("borrower", action, {
    userId,
    applicationId,
    payload: details,
    source: "user_action",
  });
}

export function emitPricingEvent(applicationId: string, eventName: string, rate?: number, details?: Record<string, any>) {
  return emitEvent("pricing", eventName, {
    applicationId,
    numericValue: rate,
    payload: details,
  });
}

export async function getEventCounts(
  domain: AnalyticsDomain,
  daysBack: number = 30
): Promise<Record<string, number>> {
  const rows = await db.select({
    eventName: analyticsEvents.eventName,
    count: sql<number>`count(*)::int`,
  }).from(analyticsEvents)
    .where(and(
      eq(analyticsEvents.domain, domain),
      gte(analyticsEvents.occurredAt, sql`now() - interval '${sql.raw(daysBack.toString())} days'`)
    ))
    .groupBy(analyticsEvents.eventName);

  const result: Record<string, number> = {};
  for (const row of rows) {
    result[row.eventName] = row.count;
  }
  return result;
}

export async function getRecentEvents(
  options: {
    domain?: AnalyticsDomain;
    applicationId?: string;
    userId?: string;
    limit?: number;
    daysBack?: number;
  } = {}
): Promise<any[]> {
  const conditions = [];
  if (options.domain) conditions.push(eq(analyticsEvents.domain, options.domain));
  if (options.applicationId) conditions.push(eq(analyticsEvents.applicationId, options.applicationId));
  if (options.userId) conditions.push(eq(analyticsEvents.userId, options.userId));
  if (options.daysBack) {
    conditions.push(gte(analyticsEvents.occurredAt, sql`now() - interval '${sql.raw(options.daysBack.toString())} days'`));
  }

  return db.select().from(analyticsEvents)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(analyticsEvents.occurredAt))
    .limit(options.limit || 50);
}

export async function getAutomationMetrics(daysBack: number = 30): Promise<{
  totalEvents: number;
  automatedEvents: number;
  automationRate: number;
  byDomain: Record<string, { total: number; automated: number }>;
}> {
  const rows = await db.select({
    domain: analyticsEvents.domain,
    automated: analyticsEvents.automationTriggered,
    count: sql<number>`count(*)::int`,
  }).from(analyticsEvents)
    .where(gte(analyticsEvents.occurredAt, sql`now() - interval '${sql.raw(daysBack.toString())} days'`))
    .groupBy(analyticsEvents.domain, analyticsEvents.automationTriggered);

  let totalEvents = 0;
  let automatedEvents = 0;
  const byDomain: Record<string, { total: number; automated: number }> = {};

  for (const row of rows) {
    const d = row.domain;
    if (!byDomain[d]) byDomain[d] = { total: 0, automated: 0 };
    byDomain[d].total += row.count;
    totalEvents += row.count;
    if (row.automated) {
      byDomain[d].automated += row.count;
      automatedEvents += row.count;
    }
  }

  return {
    totalEvents,
    automatedEvents,
    automationRate: totalEvents > 0 ? Math.round((automatedEvents / totalEvents) * 10000) / 100 : 0,
    byDomain,
  };
}

export async function getDomainInsights(domain: AnalyticsDomain, daysBack: number = 30): Promise<{
  eventCounts: Record<string, number>;
  dailyTrend: Array<{ date: string; count: number }>;
  topEntities: Array<{ entityType: string; entityId: string; count: number }>;
}> {
  const [eventCounts, dailyTrend, topEntities] = await Promise.all([
    getEventCounts(domain, daysBack),

    db.select({
      date: sql<string>`date(${analyticsEvents.occurredAt})`,
      count: sql<number>`count(*)::int`,
    }).from(analyticsEvents)
      .where(and(
        eq(analyticsEvents.domain, domain),
        gte(analyticsEvents.occurredAt, sql`now() - interval '${sql.raw(daysBack.toString())} days'`)
      ))
      .groupBy(sql`date(${analyticsEvents.occurredAt})`)
      .orderBy(sql`date(${analyticsEvents.occurredAt})`),

    db.select({
      entityType: analyticsEvents.entityType,
      entityId: analyticsEvents.entityId,
      count: sql<number>`count(*)::int`,
    }).from(analyticsEvents)
      .where(and(
        eq(analyticsEvents.domain, domain),
        gte(analyticsEvents.occurredAt, sql`now() - interval '${sql.raw(daysBack.toString())} days'`),
        sql`${analyticsEvents.entityType} IS NOT NULL`
      ))
      .groupBy(analyticsEvents.entityType, analyticsEvents.entityId)
      .orderBy(sql`count(*) desc`)
      .limit(10),
  ]);

  return {
    eventCounts,
    dailyTrend: dailyTrend.map(d => ({ date: d.date, count: d.count })),
    topEntities: topEntities.map(e => ({
      entityType: e.entityType || "",
      entityId: e.entityId || "",
      count: e.count,
    })),
  };
}
