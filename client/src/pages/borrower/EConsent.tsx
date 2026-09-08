import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, consentKeys, loanApplicationKeys } from "@/lib/queryClient";
import { useActiveApplication } from "@/hooks/useActiveApplication";
import type { LoanApplication } from "@shared/schema";
import { 
  CheckCircle, 
  Clock,
  Shield,
  FileText,
  AlertCircle,
  ChevronDown,
  ChevronUp
} from "lucide-react";
import { PageShell } from "@/components/PageShell";
import { QueryErrorState } from "@/components/ui/query-boundary";
import { ConsentField } from "@/components/patterns/ConsentField";

interface ConsentTemplate {
  id: string;
  consentType: string;
  version: string;
  title: string;
  shortDescription: string;
  fullText: string;
  regulatoryReference: string;
}

interface BorrowerConsent {
  id: string;
  consentType: string;
  consentGiven: boolean;
  consentedAt: string;
  consentMethod: string;
  /**
   * Revocation is a separate flag: revoking sets `isRevoked` and leaves
   * `consentGiven: true` as the historical record of what was once given
   * (`revokeConsentsByTypeAndUser`). Reading `consentGiven` alone therefore
   * reports a revoked consent as still in force — see `isConsentGiven` below.
   */
  isRevoked?: boolean;
  applicationId?: string | null;
}

const consentTypeLabels: Record<string, { label: string; icon: typeof Shield }> = {
  credit_authorization: { label: "Credit Report Authorization", icon: Shield },
  e_disclosure: { label: "Electronic Disclosure Consent", icon: FileText },
  privacy_policy: { label: "Privacy Policy", icon: Shield },
  fcra_notice: { label: "FCRA Notice", icon: Shield },
  econsent: { label: "Electronic Signature Consent", icon: FileText },
  disclosure: { label: "Disclosures", icon: FileText },
  intent_to_proceed: { label: "Intent to Proceed", icon: CheckCircle },
};

export default function EConsent() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [expandedConsent, setExpandedConsent] = useState<string | null>(null);
  const [agreedConsents, setAgreedConsents] = useState<Set<string>>(new Set());
  const { data: applications = [] } = useQuery<LoanApplication[]>({
    queryKey: loanApplicationKeys.all(),
  });
  const { activeApplication } = useActiveApplication(applications);

  const {
    data: templates,
    isLoading: templatesLoading,
    isError: templatesError,
    error: templatesErrorObj,
    refetch: refetchTemplates,
  } = useQuery<ConsentTemplate[]>({
    queryKey: ["/api/consent-templates"],
  });

  const {
    data: myConsents,
    isLoading: consentsLoading,
    isError: consentsError,
    error: consentsErrorObj,
    refetch: refetchConsents,
  } = useQuery<BorrowerConsent[]>({
    queryKey: consentKeys.me(),
  });

  const recordConsentMutation = useMutation({
    mutationFn: async (data: { consentType: string; templateId?: string; templateVersion?: string }) => {
      return await apiRequest("POST", "/api/consents", {
        ...data,
        applicationId: activeApplication?.id,
        consentGiven: true,
        consentMethod: "click",
        signatureType: "none",
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: consentKeys.me() });
      queryClient.invalidateQueries({ queryKey: loanApplicationKeys.actionItemsRoot() });
      toast({
        title: "Consent Recorded",
        description: "Your consent has been securely recorded.",
      });
    },
    onError: (error: Error) => {
      toast({
        variant: "destructive",
        title: "Error",
        description: error.message || "Failed to record consent",
      });
    },
  });

  const handleAgree = (consentType: string) => {
    setAgreedConsents(prev => {
      const next = new Set(prev);
      if (next.has(consentType)) {
        next.delete(consentType);
      } else {
        next.add(consentType);
      }
      return next;
    });
  };

  const handleSubmitConsent = (template: ConsentTemplate) => {
    recordConsentMutation.mutate({
      consentType: template.consentType,
      templateId: template.id,
      templateVersion: template.version,
    });
    setAgreedConsents(prev => {
      const next = new Set(prev);
      next.delete(template.consentType);
      return next;
    });
  };

  // A consent counts as IN FORCE only if it was given and has not been revoked.
  //
  // `/api/consents/me` returns the borrower's full consent history — unlike its
  // sibling getters, `getBorrowerConsentsByUser` applies no `isRevoked` filter,
  // and revoking never clears `consentGiven` (it is the record of what was once
  // given). Testing `consentGiven` alone therefore listed a revoked consent
  // under "Completed" and dropped it from "Action Required", telling the
  // borrower there was nothing to do — while `TaxReturnInsightCard`, reading
  // the very same endpoint, correctly showed the consent as needed again.
  // Two surfaces cannot disagree about one fact (DESIGN_SYSTEM §13, Agreement),
  // so this predicate now matches that one.
  const isConsentGiven = (consentType: string): boolean => {
    return (
      myConsents?.some(
        (c) =>
          c.consentType === consentType &&
          c.consentGiven &&
          !c.isRevoked &&
          (!activeApplication || c.applicationId === activeApplication.id),
      ) || false
    );
  };

  if (templatesLoading || consentsLoading) {
    return (
      <div className="p-6 flex items-center justify-center h-full">
        <div className="text-muted-foreground">Loading consents...</div>
      </div>
    );
  }

  // A fetch failure used to fall through to a zeroed-out page indistinguishable
  // from "nothing to do" — show an honest error + retry instead, right at a
  // trust-critical consent gate (ux-09).
  if (templatesError || consentsError) {
    return (
      <div className="p-4 md:p-6 max-w-3xl mx-auto">
        <QueryErrorState
          error={templatesErrorObj ?? consentsErrorObj}
          onRetry={() => {
            if (templatesError) refetchTemplates();
            if (consentsError) refetchConsents();
          }}
          title="We couldn't load your consents"
          data-testid="econsent-error"
        />
      </div>
    );
  }

  const pendingConsents = templates?.filter(t => !isConsentGiven(t.consentType)) || [];
  const completedConsents = templates?.filter(t => isConsentGiven(t.consentType)) || [];

  return (
    <PageShell
      width="wide"
      title="Electronic Consent"
      subtitle="Review and provide required consents for your mortgage application"
      titleTestId="text-econsent-title"
      contentClassName="space-y-6"
    >
      <div className="grid gap-4 md:grid-cols-3">
        <Card data-testid="card-pending-consents">
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Pending</CardTitle>
            <Clock className="h-4 w-4 text-warning-subtle-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{pendingConsents.length}</div>
            <p className="text-xs text-muted-foreground">Consents required</p>
          </CardContent>
        </Card>

        <Card data-testid="card-completed-consents">
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Completed</CardTitle>
            <CheckCircle className="h-4 w-4 text-success-subtle-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{completedConsents.length}</div>
            <p className="text-xs text-muted-foreground">Consents given</p>
          </CardContent>
        </Card>

        <Card data-testid="card-total-consents">
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Required</CardTitle>
            <FileText className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{templates?.length || 0}</div>
            <p className="text-xs text-muted-foreground">For your application</p>
          </CardContent>
        </Card>
      </div>

      {pendingConsents.length > 0 && (
        <div className="space-y-4">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <AlertCircle className="h-5 w-5 text-warning-subtle-foreground" />
            Action Required
          </h2>
          
          {pendingConsents.map((template) => {
            const isExpanded = expandedConsent === template.id;
            const isAgreed = agreedConsents.has(template.consentType);
            const typeInfo = consentTypeLabels[template.consentType] || { label: template.title, icon: FileText };
            const Icon = typeInfo.icon;

            return (
              <Card key={template.id} data-testid={`card-consent-${template.consentType}`}>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <Icon className="h-5 w-5 text-primary" />
                      <div>
                        <CardTitle className="text-lg">{template.title}</CardTitle>
                        <CardDescription>{template.shortDescription}</CardDescription>
                      </div>
                    </div>
                    <Badge variant="outline">Required</Badge>
                  </div>
                </CardHeader>
                <CardContent>
                  <Button
                    variant="ghost"
                    className="w-full justify-between"
                    onClick={() => setExpandedConsent(isExpanded ? null : template.id)}
                    data-testid={`button-expand-${template.consentType}`}
                  >
                    <span>Read Full Text</span>
                    {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                  </Button>
                  
                  {isExpanded && (
                    <ScrollArea className="h-64 mt-4 p-4 border rounded-md">
                      <div className="text-sm whitespace-pre-wrap">{template.fullText}</div>
                      {template.regulatoryReference && (
                        <p className="text-xs text-muted-foreground mt-4">
                          Reference: {template.regulatoryReference}
                        </p>
                      )}
                    </ScrollArea>
                  )}
                </CardContent>
                <CardFooter className="flex-col gap-4">
                  <Separator />
                  <div className="flex w-full flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                    {/* The full text is one click away above and is not
                        summarised here — so the agreement names the document
                        rather than a vague "the above", and the consequence
                        sits outside the label (DESIGN_SYSTEM §13, Honesty). */}
                    <ConsentField
                      id={`agree-${template.id}`}
                      className="flex-1"
                      checked={isAgreed}
                      onCheckedChange={() => handleAgree(template.consentType)}
                      checkboxTestId={`checkbox-agree-${template.consentType}`}
                      labelTestId={`label-agree-${template.consentType}`}
                      data-testid={`consent-agree-${template.consentType}`}
                      label={`I have read and agree to the ${template.title}.`}
                      consequence="Nothing is recorded until you submit, and you can read the full text above first."
                    />
                    <Button
                      onClick={() => handleSubmitConsent(template)}
                      disabled={!isAgreed || recordConsentMutation.isPending}
                      className="shrink-0"
                      data-testid={`button-submit-${template.consentType}`}
                    >
                      {recordConsentMutation.isPending ? "Saving..." : "Submit Consent"}
                    </Button>
                  </div>
                </CardFooter>
              </Card>
            );
          })}
        </div>
      )}

      {completedConsents.length > 0 && (
        <div className="space-y-4">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <CheckCircle className="h-5 w-5 text-success-subtle-foreground" />
            Completed Consents
          </h2>
          
          <div className="grid gap-3">
            {completedConsents.map((template) => {
              const consent = myConsents?.find(c => c.consentType === template.consentType);
              const typeInfo = consentTypeLabels[template.consentType] || { label: template.title, icon: FileText };
              const Icon = typeInfo.icon;

              return (
                <Card key={template.id} className="bg-muted/30" data-testid={`card-completed-${template.consentType}`}>
                  <CardContent className="flex items-center justify-between p-4">
                    <div className="flex items-center gap-3">
                      <Icon className="h-5 w-5 text-success-subtle-foreground" />
                      <div>
                        <p className="font-medium">{template.title}</p>
                        <p className="text-xs text-muted-foreground">
                          Signed on {consent ? new Date(consent.consentedAt).toLocaleDateString() : "N/A"}
                        </p>
                      </div>
                    </div>
                    <Badge className="bg-success-subtle text-success-subtle-foreground">
                      <CheckCircle className="h-3 w-3 mr-1" />
                      Complete
                    </Badge>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </div>
      )}

      {templates?.length === 0 && (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <CheckCircle className="h-12 w-12 text-success-subtle-foreground mb-4" />
            <h3 className="text-lg font-semibold">No Consents Required</h3>
            <p className="text-muted-foreground text-center">
              There are no consent forms available at this time.
            </p>
          </CardContent>
        </Card>
      )}
    </PageShell>
  );
}
