import { buildCliWorkspaceProvenance } from '../../../../shared/cli-workspace-provenance'
import {
  finishAutomationWorkspaceProvenanceRequest,
  releaseAutomationWorkspaceProvenanceRequest,
  resolveAutomationWorkspaceProvenance
} from '../../../automations/workspace-provenance'
import { WorktreeAgentLaunchPreCreateError } from '../../../agent-launch/agent-launch-worktree-resolution'
import { shouldRejectLegacyCustomAgentLaunch } from '../../../agent-launch/legacy-launch-custom-agent-guard'
import { defineMethod, type RpcMethod } from '../core'
import { resolveRpcWorkspaceCreatorProvenance } from '../workspace-creator-context'
import { WorktreeCreate } from './worktree-schemas'

/** worktree.create: the host-atomic create + agent-launch entry point. */
export const WORKTREE_CREATE_METHOD: RpcMethod = defineMethod({
  name: 'worktree.create',
  params: WorktreeCreate,
  handler: async (params, context) => {
    const { runtime, clientKind, pairedDeviceId } = context
    // U7: a remote client (authenticated clientKind) may not name a custom id on
    // the legacy built-in create path — it cannot be host-resolved without the
    // host-atomic agentLaunch request. Reject at the boundary (no worktree),
    // in-band as created:false so the composer keeps its typed recovery hints.
    // In-process desktop/automation callers bypass this handler and keep customs.
    if (
      shouldRejectLegacyCustomAgentLaunch({
        hasAgentLaunch: params.agentLaunch !== undefined,
        requestClientKind: clientKind,
        requestedAgentId: params.startupAgent ?? params.createdWithAgent
      })
    ) {
      return {
        created: false,
        agentLaunchResult: { status: 'rejected', requestError: { code: 'untrusted_reference' } }
      }
    }
    // Why: a mobile create interrupted by a connection migration is retried with
    // the same clientMutationId; dedupe so the host returns the in-flight/created
    // worktree instead of spawning a duplicate. No key (desktop/CLI) runs plainly.
    return runtime.dedupeWorktreeCreate(params.repo, params.clientMutationId, async () => {
      const repo = await runtime.showRepo(params.repo)
      const automationProvenance = resolveAutomationWorkspaceProvenance({
        authority: runtime,
        repoSelector: params.repo,
        repo,
        request: params.automationProvenanceRequest
      })
      // Why: provenance tokens are reserved before creation so retries can recover,
      // but failed create attempts must release the reservation for a safe retry.
      try {
        const result = await runtime.createManagedWorktree({
          repoSelector: params.repo,
          name: params.name ?? '',
          baseBranch: params.baseBranch,
          compareBaseRef: params.compareBaseRef,
          branchNameOverride: params.branchNameOverride,
          linkedIssue: params.linkedIssue,
          linkedPR: params.linkedPR,
          linkedLinearIssue: params.linkedLinearIssue,
          linkedLinearIssueWorkspaceId: params.linkedLinearIssueWorkspaceId,
          linkedLinearIssueOrganizationUrlKey: params.linkedLinearIssueOrganizationUrlKey,
          linkedGitLabMR: params.linkedGitLabMR,
          linkedGitLabIssue: params.linkedGitLabIssue,
          linkedBitbucketPR: params.linkedBitbucketPR,
          linkedAzureDevOpsPR: params.linkedAzureDevOpsPR,
          linkedGiteaPR: params.linkedGiteaPR,
          linkedWorkItem: params.linkedWorkItem,
          linkedTaskSourceContext: params.linkedTaskSourceContext,
          comment: params.comment,
          displayName: params.displayName,
          telemetrySource: params.telemetrySource,
          workspaceStatus: params.workspaceStatus,
          manualOrder: params.manualOrder,
          sparseCheckout: params.sparseCheckout,
          pushTarget: params.pushTarget,
          runHooks: params.runHooks === true,
          activate: params.activate === true,
          setupDecision: params.setupDecision,
          createdWithAgent: params.createdWithAgent ?? params.startupAgent,
          automationProvenance,
          cliProvenance: buildCliWorkspaceProvenance(params.cliProvenanceRequest, {
            startupAgent: params.startupAgent ?? params.createdWithAgent,
            createdAt: Date.now()
          }),
          creatorProvenance: resolveRpcWorkspaceCreatorProvenance(context),
          startup: params.startupCommand
            ? {
                command: params.startupCommand,
                ...(params.startupEnv ? { env: params.startupEnv } : {}),
                ...(params.startupLaunchConfig ? { launchConfig: params.startupLaunchConfig } : {}),
                ...(params.startupCommandDelivery
                  ? { startupCommandDelivery: params.startupCommandDelivery }
                  : {})
              }
            : undefined,
          ...(params.startupAgent ? { startupAgent: params.startupAgent } : {}),
          ...(params.startupPrompt !== undefined ? { startupPrompt: params.startupPrompt } : {}),
          startupDraft: params.startupDraft,
          // The host-atomic launch request; when present the host ignores the
          // client startup/createdWithAgent for the agent terminal. clientKind
          // scopes admission/intent and is never derived from client JSON; the
          // paired device narrows that principal so one phone's capacity and
          // recovery rows are its own.
          ...(params.agentLaunch
            ? {
                agentLaunch: params.agentLaunch,
                agentLaunchClientKind: clientKind,
                ...(pairedDeviceId ? { agentLaunchDeviceId: pairedDeviceId } : {})
              }
            : {}),
          ...(params.agentLaunchTelemetry
            ? { agentLaunchTelemetry: params.agentLaunchTelemetry }
            : {}),
          lineage: {
            parentWorkspace: params.parentWorkspace,
            envParentWorkspace: params.envParentWorkspace,
            parentWorktree: params.parentWorktree,
            ...(params.cwdParentWorktree ? { cwdParentWorktree: params.cwdParentWorktree } : {}),
            noParent: params.noParent === true,
            callerTerminalHandle: params.callerTerminalHandle,
            orchestrationContext: params.orchestrationContext
          }
        })
        finishAutomationWorkspaceProvenanceRequest(params.automationProvenanceRequest)
        // Why: agent callers need a stable dispatch target without traversing
        // terminal-list layout duplicates after creating the worktree; the
        // host-resolved agentLaunch path owns the same contract as startupAgent.
        return (params.startupAgent || params.agentLaunch) && result.startupTerminal?.handle
          ? { ...result, agentTerminalHandle: result.startupTerminal.handle }
          : result
      } catch (error) {
        releaseAutomationWorkspaceProvenanceRequest(params.automationProvenanceRequest)
        // A pre-create agent-launch rejection created no worktree. Return it
        // in-band as `created: false` rather than throwing: an RPC error
        // envelope serializes lossily and would drop the typed recovery hints
        // the composer needs to stay open on every transport.
        if (error instanceof WorktreeAgentLaunchPreCreateError && error.failure) {
          return {
            created: false,
            agentLaunchResult: { status: 'failed', failure: error.failure }
          }
        }
        if (error instanceof WorktreeAgentLaunchPreCreateError && error.requestError) {
          return {
            created: false,
            agentLaunchResult: { status: 'rejected', requestError: error.requestError }
          }
        }
        throw error
      }
    })
  }
})
