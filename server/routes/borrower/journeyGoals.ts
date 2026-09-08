// Borrower routes: Homeownership goal, gap analysis, credit actions, savings, credit recommendations.
// One registrar in the original registration order — see ./index.ts.
import type { Express } from "express";
import { type IStorage } from "../../storage";
import { isAuthenticated } from "../../auth";
import { insertHomeownershipGoalSchema, insertCreditActionSchema, insertSavingsTransactionSchema, type User } from "@shared/schema";
import { z } from "zod";
import { routeParam } from "../../http/routeParams";
import { deriveHomebuyerPlanningStage } from "@shared/homebuyerJourney";

// Verify that an internal staff user is actually assigned to the given application.
// Returns true for admin (unrestricted), checks LO assignment for lo/loa, and
// deal-team membership for processor/underwriter/closer.
// External partner roles (broker, lender) are NOT permitted by this helper.
// Exported: the LO-2 scenario route reuses this gate (one access model, no forks).

export function registerJourneyGoalRoutes(
  app: Express,
  storage: IStorage,
) {
  // Get or create homeownership goal for the current user
  app.get("/api/homeownership-goal", isAuthenticated, async (req, res) => {
    try {
      const user = req.user as User;
      const goal = await storage.getHomeownershipGoal(user.id);
      
      if (!goal) {
        return res.json({ goal: null, planningStage: deriveHomebuyerPlanningStage(null), milestones: [] });
      }

      const [creditActions, savingsTransactions, milestones] = await Promise.all([
        storage.getCreditActions(goal.id),
        storage.getSavingsTransactions(goal.id),
        storage.getJourneyMilestones(goal.id),
      ]);

      res.json({
        goal,
        planningStage: deriveHomebuyerPlanningStage(goal),
        creditActions,
        savingsTransactions,
        milestones,
      });
    } catch (error) {
      console.error("Get homeownership goal error:", error);
      res.status(500).json({ error: "Failed to get homeownership goal" });
    }
  });

  // Create homeownership goal
  app.post("/api/homeownership-goal", isAuthenticated, async (req, res) => {
    try {
      const user = req.user as User;
      
      // Check if goal already exists
      const existing = await storage.getHomeownershipGoal(user.id);
      if (existing) {
        return res.status(400).json({ error: "Homeownership goal already exists" });
      }

      const validated = insertHomeownershipGoalSchema.parse({
        ...req.body,
        userId: user.id,
      });

      const goal = await storage.createHomeownershipGoal(validated);

      // Create initial milestone for starting the journey
      await storage.createJourneyMilestone({
        goalId: goal.id,
        milestoneType: "journey_started",
        title: "Journey Started",
        description: "You've taken the first step toward homeownership!",
        celebrationMessage: "Welcome to your homeownership journey! We're excited to help you achieve your dream.",
        pointsAwarded: 10,
      });

      res.status(201).json({ goal, planningStage: deriveHomebuyerPlanningStage(goal) });
    } catch (error) {
      console.error("Create homeownership goal error:", error);
      res.status(500).json({ error: "Failed to create homeownership goal" });
    }
  });

  // Update homeownership goal
  app.patch("/api/homeownership-goal", isAuthenticated, async (req, res) => {
    try {
      const user = req.user as User;
      
      // Validate update data using partial insert schema
      const updateSchema = insertHomeownershipGoalSchema.partial();
      const validated = updateSchema.parse(req.body);
      
      const goal = await storage.updateHomeownershipGoal(user.id, validated);
      
      if (!goal) {
        return res.status(404).json({ error: "Homeownership goal not found" });
      }

      res.json({ goal, planningStage: deriveHomebuyerPlanningStage(goal) });
    } catch (error) {
      console.error("Update homeownership goal error:", error);
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid data", details: error.issues });
      }
      res.status(500).json({ error: "Failed to update homeownership goal" });
    }
  });

  // Get gap analysis (calculated from goal data)
  app.get("/api/homeownership-goal/gap-analysis", isAuthenticated, async (req, res) => {
    try {
      const user = req.user as User;
      const goal = await storage.getHomeownershipGoal(user.id);
      
      if (!goal) {
        return res.json({ hasGoal: false });
      }

      // Calculate gap analysis
      const currentCredit = goal.currentCreditScore || 0;
      const targetCredit = goal.targetCreditScore || 640;
      const creditGap = Math.max(0, targetCredit - currentCredit);

      const currentSavings = parseFloat(goal.currentSavingsBalance?.toString() || "0");
      const targetDownPayment = parseFloat(goal.targetDownPayment?.toString() || "0");
      const savingsGap = Math.max(0, targetDownPayment - currentSavings);

      const monthlyIncome = parseFloat(goal.monthlyIncome?.toString() || "0");
      const monthlyDebts = parseFloat(goal.monthlyDebts?.toString() || "0");
      const currentDTI = monthlyIncome > 0 ? (monthlyDebts / monthlyIncome) * 100 : 0;
      
      // Calculate maximum housing payment at 43% DTI guideline
      const maxDTI = 43;
      const availableForPayment = monthlyIncome * (maxDTI / 100) - monthlyDebts;
      
      // Estimate time to reach goals
      const monthlySavingsRate = parseFloat(goal.currentMonthlySavings?.toString() || "0");
      const monthsToSavingsGoal = monthlySavingsRate > 0 
        ? Math.ceil(savingsGap / monthlySavingsRate) 
        : null;

      // Calculate journey progress percentage
      const creditProgress = targetCredit > 0 ? Math.min(100, (currentCredit / targetCredit) * 100) : 0;
      const savingsProgress = targetDownPayment > 0 ? Math.min(100, (currentSavings / targetDownPayment) * 100) : 0;
      const overallProgress = (creditProgress + savingsProgress) / 2;

      res.json({
        hasGoal: true,
        analysis: {
          credit: {
            current: currentCredit,
            target: targetCredit,
            gap: creditGap,
            progress: creditProgress,
            status: creditGap === 0 ? "ready" : creditGap <= 20 ? "close" : "working",
          },
          savings: {
            current: currentSavings,
            target: targetDownPayment,
            gap: savingsGap,
            progress: savingsProgress,
            monthlyRate: monthlySavingsRate,
            monthsToGoal: monthsToSavingsGoal,
            status: savingsGap === 0 ? "ready" : savingsProgress >= 75 ? "close" : "working",
          },
          dti: {
            current: currentDTI,
            maxAllowed: maxDTI,
            availableForPayment,
            status: currentDTI <= maxDTI ? "within_guideline" : "above_guideline",
          },
          overall: {
            progress: overallProgress,
            phase: goal.currentPhase,
            journeyDay: goal.journeyDay,
            goalsComplete: creditGap === 0 && savingsGap === 0 && currentDTI <= maxDTI,
          },
        },
      });
    } catch (error) {
      console.error("Get gap analysis error:", error);
      res.status(500).json({ error: "Failed to calculate gap analysis" });
    }
  });

  // Add credit action
  app.post("/api/homeownership-goal/credit-actions", isAuthenticated, async (req, res) => {
    try {
      const user = req.user as User;
      const goal = await storage.getHomeownershipGoal(user.id);
      
      if (!goal) {
        return res.status(404).json({ error: "Homeownership goal not found" });
      }

      const validated = insertCreditActionSchema.parse({
        ...req.body,
        goalId: goal.id,
      });

      const action = await storage.createCreditAction(validated);
      res.status(201).json({ action });
    } catch (error) {
      console.error("Create credit action error:", error);
      res.status(500).json({ error: "Failed to create credit action" });
    }
  });

  // Update credit action
  app.patch("/api/credit-actions/:id", isAuthenticated, async (req, res) => {
    try {
      const user = req.user as User;
      // Verify the credit action belongs to the current user's homeownership goal
      const goal = await storage.getHomeownershipGoal(user.id);
      if (!goal) {
        return res.status(403).json({ error: "Access denied" });
      }
      const existing = await storage.getCreditActionById(routeParam(req, "id"));
      if (!existing || existing.goalId !== goal.id) {
        return res.status(404).json({ error: "Credit action not found" });
      }

      // Validate update data using partial insert schema; strip goalId to prevent reassignment
      const updateSchema = insertCreditActionSchema.partial();
      const { goalId: _strip, ...bodyWithoutOwner } = req.body;
      const validated = updateSchema.parse(bodyWithoutOwner);
      
      const action = await storage.updateCreditAction(routeParam(req, "id"), validated, goal.id);
      
      if (!action) {
        return res.status(404).json({ error: "Credit action not found" });
      }

      res.json({ action });
    } catch (error) {
      console.error("Update credit action error:", error);
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid data", details: error.issues });
      }
      res.status(500).json({ error: "Failed to update credit action" });
    }
  });

  // Add savings transaction
  app.post("/api/homeownership-goal/savings", isAuthenticated, async (req, res) => {
    try {
      const user = req.user as User;
      const goal = await storage.getHomeownershipGoal(user.id);
      
      if (!goal) {
        return res.status(404).json({ error: "Homeownership goal not found" });
      }

      const currentBalance = parseFloat(goal.currentSavingsBalance?.toString() || "0");
      const amount = parseFloat(req.body.amount);
      const newBalance = currentBalance + amount;

      const validated = insertSavingsTransactionSchema.parse({
        goalId: goal.id,
        transactionType: req.body.transactionType || "manual_deposit",
        amount: req.body.amount,
        description: req.body.description,
        runningBalance: newBalance.toString(),
      });

      const transaction = await storage.createSavingsTransaction(validated);

      // Update the goal's current savings balance
      await storage.updateHomeownershipGoal(user.id, {
        currentSavingsBalance: newBalance.toString(),
        savingsProgress: newBalance.toString(),
      });

      // Check for savings milestones
      const milestoneThresholds = [
        { amount: 500, type: "savings_500", title: "First $500 Saved!" },
        { amount: 1000, type: "savings_1000", title: "$1,000 Milestone!" },
        { amount: 2500, type: "savings_2500", title: "$2,500 Saved!" },
        { amount: 5000, type: "savings_5000", title: "$5,000 Milestone!" },
        { amount: 10000, type: "savings_10000", title: "$10,000 Saved!" },
      ];

      for (const milestone of milestoneThresholds) {
        if (newBalance >= milestone.amount && currentBalance < milestone.amount) {
          await storage.createJourneyMilestone({
            goalId: goal.id,
            milestoneType: milestone.type,
            title: milestone.title,
            description: `You've saved $${milestone.amount.toLocaleString()} toward your home!`,
            celebrationMessage: "Great progress! Every dollar brings you closer to homeownership.",
            pointsAwarded: milestone.amount / 100,
          });
        }
      }

      res.status(201).json({ transaction, newBalance });
    } catch (error) {
      console.error("Create savings transaction error:", error);
      res.status(500).json({ error: "Failed to create savings transaction" });
    }
  });

  // Get credit improvement recommendations
  app.get("/api/homeownership-goal/credit-recommendations", isAuthenticated, async (req, res) => {
    try {
      const user = req.user as User;
      const goal = await storage.getHomeownershipGoal(user.id);
      
      if (!goal) {
        return res.json({ recommendations: [] });
      }

      const currentScore = goal.currentCreditScore || 0;
      const recommendations = [];

      // Generate personalized recommendations based on credit score
      if (currentScore < 580) {
        recommendations.push({
          priority: "high",
          actionType: "pay_down_card",
          title: "Pay Down Credit Cards",
          description: "Reduce your credit utilization to under 30%. This is the fastest way to boost your score.",
          estimatedPointsGain: 15,
          timeframe: "1-2 months",
        });
        recommendations.push({
          priority: "high",
          actionType: "dispute_error",
          title: "Dispute Credit Errors",
          description: "Review your credit report for errors. Removing incorrect negative items can quickly improve your score.",
          estimatedPointsGain: 20,
          timeframe: "30-45 days",
        });
      }

      if (currentScore >= 580 && currentScore < 620) {
        recommendations.push({
          priority: "medium",
          actionType: "on_time_payment",
          title: "Set Up Auto-Pay",
          description: "Never miss a payment. Set up automatic payments for all your bills.",
          estimatedPointsGain: 10,
          timeframe: "3-6 months",
        });
        recommendations.push({
          priority: "medium",
          actionType: "authorized_user",
          title: "Become an Authorized User",
          description: "Ask a family member with good credit to add you as an authorized user on their oldest card.",
          estimatedPointsGain: 15,
          timeframe: "1-2 months",
        });
      }

      if (currentScore >= 620 && currentScore < 680) {
        recommendations.push({
          priority: "low",
          actionType: "credit_mix",
          title: "Diversify Credit Types",
          description: "A mix of credit types (cards, installment loans) can help your score.",
          estimatedPointsGain: 8,
          timeframe: "3-6 months",
        });
      }

      // Always recommend
      recommendations.push({
        priority: "medium",
        actionType: "utilization",
        title: "Keep Utilization Low",
        description: "Try to use less than 10% of your available credit for the best scores.",
        estimatedPointsGain: 10,
        timeframe: "Ongoing",
      });

      res.json({ recommendations, currentScore, targetScore: goal.targetCreditScore });
    } catch (error) {
      console.error("Get credit recommendations error:", error);
      res.status(500).json({ error: "Failed to get credit recommendations" });
    }
  });

  // ===== RATE LOCK SYSTEM =====

}
