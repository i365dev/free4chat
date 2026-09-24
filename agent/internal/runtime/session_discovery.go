package runtime

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/i365dev/free4chat/agent/internal/harness"
	"github.com/i365dev/free4chat/agent/internal/types"
)

/*
 * Task Session Continuation: Runtime-local discovery and tokenization (#409).
 *
 * This file owns the ONLY place where real Harness session identity and real
 * cwd values are converted into something a browser may hold. Everything a
 * Human sees is a bounded, sanitized presentation:
 *
 *	real ACP session id  -> sessionToken  (Runtime memory only)
 *	real cwd             -> projectToken  (Runtime memory only)
 *	real ACP cursor      -> pageToken     (Runtime memory only)
 *
 * The tokens are cryptographically random, bound to the EXACT Human
 * participant that requested discovery, short-lived, bounded in count, never
 * persisted, never logged, never projected into status or analytics, and lost
 * with the process. A token is a handle, not authority: the Room is still the
 * authorization boundary and the Runtime re-validates the Human on every use.
 *
 * The cache is deliberately NOT durable. A Runtime restart (or a TTL sweep) is
 * reported to the Human as `selection_expired`, which the UI resolves by
 * reloading discovery — never by silently continuing a different conversation.
 *
 * FRESHNESS CONTRACT: the Runtime never caches the Harness SESSION LIST. Every
 * fresh discovery (Continue session, an explicit Refresh, or a project change)
 * issues a new `session/list` to the Harness, so a provider that gained or lost
 * a session since the previous look is reflected immediately, on the same
 * resident Runtime and the same ACP process. The only retained state is the
 * short-lived opaque token mappings below plus the POSITION of an in-flight
 * pagination (an ACP cursor and the not-yet-returned remainder of the page that
 * cursor produced). A page token can never serve a first page.
 */

const (
	// taskSessionTokenTTL bounds every issued token. The Room never waits
	// anywhere near this long: START is one PREPARE round trip. The TTL exists
	// so a token a Human abandoned can never be replayed much later.
	taskSessionTokenTTL = 5 * time.Minute
	// taskSessionMaxSessionTokens bounds concurrent selections per Runtime.
	taskSessionMaxSessionTokens = 64
	// taskSessionMaxProjectTokens bounds the discovered project catalog.
	taskSessionMaxProjectTokens = types.MaxResidentSessionProjects
	// taskSessionMaxPageTokens bounds in-flight pagination handles. A page
	// token owns a bounded remainder of one adapter page (<= 50 descriptors).
	taskSessionMaxPageTokens = 8
	// taskSessionMaxACPPagesPerList bounds how many provider pages ONE product
	// page may consume while it is filtering and deduplicating. Without it, a
	// Harness that returns pages full of Runtime-owned workspace sessions
	// could make one click walk an unbounded number of pages.
	taskSessionMaxACPPagesPerList = 3
	// taskSessionTokenBytes is the raw entropy per token.
	taskSessionTokenBytes = 24
)

// errTaskSessionUnsupported means this resident's product policy does not
// enable Task Session Continuation at all.
var errTaskSessionUnsupported = errors.New("task session continuation is not enabled for this Harness")

// sessionProjectHomeDirectory resolves the local home directory used ONLY to
// abbreviate a project DISPLAY label. It is a presentation concern: the label
// is never identity and never travels back to the Runtime as a cwd.
var sessionProjectHomeDirectory = os.UserHomeDir

// taskSessionSelection is one Human-bound selection handle.
type taskSessionSelection struct {
	sessionID          string
	cwd                string
	humanParticipantID string
	expiresAt          int64
}

// taskSessionProject is one Human-bound project handle. Label is display-only.
type taskSessionProject struct {
	cwd                string
	label              string
	humanParticipantID string
	expiresAt          int64
}

// taskSessionPage is one Human-bound pagination handle. It owns the exact cwd
// filter it was opened under, the provider cursor to continue from, and the
// already-fetched remainder of the current adapter page, so a product page
// boundary can never lose or duplicate rows.
type taskSessionPage struct {
	cwd     *string
	cursor  string
	pending []harness.ACPSessionInfo
	human   string
	expires int64
}

// taskSessionDiscoveryCache is Runtime-local, in-memory only.
type taskSessionDiscoveryCache struct {
	sessions map[string]taskSessionSelection
	projects map[string]taskSessionProject
	pages    map[string]taskSessionPage
}

// taskSessionControlBusy reports whether the one outstanding session-control
// slot is taken. It is transient Runtime state, never persisted.
func (r *ResidentRuntime) taskSessionControlBusy() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.sessionControlBusy
}

func (r *ResidentRuntime) setTaskSessionControlBusy(busy bool) {
	r.mu.Lock()
	r.sessionControlBusy = busy
	r.mu.Unlock()
}

// taskSessionPolicyEnabled reports whether this resident's launcher product
// policy enables Task Session Continuation. It is the Runtime-side half of the
// same single decision the launcher registry records, and it is deliberately
// independent of ACP capability advertisement (#409: advertisement is not
// evidence that a native session is discoverable or continuable).
func (r *ResidentRuntime) taskSessionPolicyEnabled() bool {
	if !r.options.TaskSessionContinuation {
		return false
	}
	_, err := r.handoffAdapter()
	return err == nil
}

// CurrentRuntimeFeatures is the additive, coarse discovery projection this
// resident publishes at join/create. It returns nil when no feature applies,
// so an unsupported Harness joins with exactly the payload an older Runtime
// sent and an older Room sees nothing new.
//
// This is presentation/discovery metadata only. It is never authorization: the
// Room still validates the current resident socket, the Human's Task ownership,
// and the advertised feature before it will forward a session control, and
// this Runtime re-checks the same product policy on every request.
func (r *ResidentRuntime) CurrentRuntimeFeatures() *types.RuntimeFeatureProjection {
	features := types.RuntimeFeatureProjection{
		TaskSessionContinuation: r.taskSessionPolicyEnabled(),
		// #421: this Runtime understands the private, fire-and-forget
		// execution reconciliation control. It is advertised unconditionally
		// because it is a property of THIS Runtime build, not of a launcher:
		// any resident can re-state the transient execution projection of the
		// Task scopes it owns.
		TaskExecutionReconciliation: true,
	}
	if features.Empty() {
		return nil
	}
	return &features
}

// dispatchSessionControl handles ONE private session-control request. It is
// intentionally asynchronous with respect to the resident reader: a
// `session/list` can take up to the adapter's control timeout, and the reader
// must stay free so an exact-turn interrupt still reaches the Runtime while a
// Human is browsing sessions.
//
// At most ONE control is processed per Runtime at a time. A second request is
// answered with a bounded `busy` result rather than queued, so an operator
// cannot build an unbounded local queue.
func (r *ResidentRuntime) dispatchSessionControl(
	stream types.ResidentEventStream,
	control *types.ResidentSessionControl,
) {
	if control == nil {
		return
	}
	if r.taskSessionControlBusy() {
		r.replySessionResult(stream, types.ResidentSessionResult{
			Kind:      control.Kind,
			RequestID: control.RequestID,
			Error:     types.ResidentSessionErrorBusy,
		})
		return
	}
	r.setTaskSessionControlBusy(true)
	go func() {
		defer r.setTaskSessionControlBusy(false)
		result := r.runSessionControl(control)
		if r.isStopped() {
			return
		}
		r.replySessionResult(stream, result)
	}()
}

// replySessionResult delivers one bounded result on the exact stream the
// control arrived on. A stream that has already been replaced is never
// written to: its identity is re-checked immediately before the write.
func (r *ResidentRuntime) replySessionResult(
	stream types.ResidentEventStream,
	result types.ResidentSessionResult,
) {
	if stream == nil || !r.isCurrentResidentStream(stream) {
		return
	}
	ctx, cancel := sessionResultContext()
	defer cancel()
	if err := stream.SendSessionResult(ctx, result); err != nil {
		// A failed reply is a transport fact, not a Room fact. The Human's
		// request simply times out and is retried; nothing is persisted.
		r.log("task_session_result_failed", map[string]string{
			"operation": string(result.Kind),
		})
	}
}

// runSessionControl executes one control and maps every failure to a bounded,
// secret-free error code. Raw adapter/ACP errors are never forwarded: they can
// quote local session identity or absolute paths.
func (r *ResidentRuntime) runSessionControl(control *types.ResidentSessionControl) types.ResidentSessionResult {
	base := types.ResidentSessionResult{Kind: control.Kind, RequestID: control.RequestID}
	if r.isStopped() {
		base.Error = types.ResidentSessionErrorUnavailable
		return base
	}
	if !r.taskSessionPolicyEnabled() {
		base.Error = types.ResidentSessionErrorUnsupported
		return base
	}
	switch control.Kind {
	case types.ResidentSessionControlList:
		return r.listTaskSessions(control)
	case types.ResidentSessionControlPrepare:
		return r.prepareTaskSession(control)
	case types.ResidentSessionControlCancel:
		return r.cancelTaskSession(control)
	default:
		base.Error = types.ResidentSessionErrorInvalid
		return base
	}
}

// listTaskSessions resolves one discovery page and tokenizes it.
func (r *ResidentRuntime) listTaskSessions(control *types.ResidentSessionControl) types.ResidentSessionResult {
	result := types.ResidentSessionResult{Kind: control.Kind, RequestID: control.RequestID}
	adapter, err := r.handoffAdapter()
	if err != nil {
		result.Error = types.ResidentSessionErrorUnsupported
		return result
	}

	human := control.HumanParticipantID
	if !r.sessionHumanIsCurrent(human) {
		result.Error = types.ResidentSessionErrorExpired
		return result
	}
	now := time.Now().UnixMilli()
	r.mu.Lock()
	r.pruneTaskSessionCacheLocked(now)
	page, cwd, ok := r.resolvePageTokenLocked(control.PageToken, human)
	if !ok {
		// An unknown, expired, or another Human's page token is reported as
		// expired. It is never silently restarted from page one, because that
		// would duplicate rows the Human already saw.
		r.mu.Unlock()
		result.Error = types.ResidentSessionErrorExpired
		return result
	}
	if control.PageToken == "" && control.ProjectToken != "" {
		project, found := r.taskSessionProjects[control.ProjectToken]
		if !found || project.expiresAt <= now || project.humanParticipantID != human {
			r.mu.Unlock()
			result.Error = types.ResidentSessionErrorExpired
			return result
		}
		filtered := project.cwd
		cwd = &filtered
	}
	if cwd != nil {
		value := *cwd
		cwd = &value
	}
	r.mu.Unlock()

	// page.pending is owned by this goroutine now: the page token was consumed
	// above, so no other request can be holding it.
	pending := page.pending
	cursor := page.cursor
	fetched := 0
	for len(pending) == 0 && fetched < taskSessionMaxACPPagesPerList {
		pageResult, listErr := adapter.ListSessions(harness.ACPSessionListOptions{Cwd: cwd, Cursor: cursor})
		if listErr != nil {
			if fetched > 0 {
				// A later provider page failed after at least one usable page:
				// report the rows already discovered with no next token rather
				// than discarding a page the Human can already choose from.
				break
			}
			result.Error = types.ResidentSessionErrorUnavailable
			r.log("task_session_list_failed", map[string]string{"failureClass": turnFailureClassOf(listErr)})
			return result
		}
		fetched++
		cursor = pageResult.NextCursor
		pending = append(pending, r.filterTaskSessions(pageResult.Sessions)...)
		if cursor == "" {
			break
		}
	}

	rows := make([]types.ResidentTaskSession, 0, types.MaxResidentSessionRows)
	r.mu.Lock()
	r.pruneTaskSessionCacheLocked(now)
	projectIndex := make(map[string]string, len(r.taskSessionProjects))
	for token, project := range r.taskSessionProjects {
		projectIndex[project.cwd] = token
	}
	nextPageToken := ""
	for _, info := range pending {
		if len(rows) >= types.MaxResidentSessionRows {
			break
		}
		token, issueErr := r.issueSessionTokenLocked(info, human, now)
		if issueErr != nil {
			break
		}
		projectToken, projectErr := r.issueProjectTokenLocked(info.Cwd, human, now, projectIndex)
		if projectErr != nil {
			break
		}
		rows = append(rows, types.ResidentTaskSession{
			Token:        token,
			Title:        info.Title,
			ProjectToken: projectToken,
			ProjectLabel: r.taskSessionProjects[projectToken].label,
			UpdatedAt:    info.UpdatedAt,
		})
	}
	// A later row can reveal a basename collision. Refresh this page's labels
	// only after all tokens have been issued, so every duplicate in the page is
	// disambiguated consistently before it crosses the Runtime boundary.
	for index := range rows {
		if project, found := r.taskSessionProjects[rows[index].ProjectToken]; found {
			rows[index].ProjectLabel = project.label
		}
	}
	consumed := len(rows)
	remainder := pending[min(consumed, len(pending)):]
	if len(remainder) > 0 || cursor != "" {
		if token, issueErr := r.issuePageTokenLocked(cwd, cursor, remainder, human, now); issueErr == nil {
			nextPageToken = token
		}
	}
	hasMore := nextPageToken != ""
	projects := r.projectCatalogLocked(human, now)
	r.mu.Unlock()

	result.OK = true
	result.Sessions = rows
	result.Projects = projects
	result.NextPageToken = nextPageToken
	result.HasMore = hasMore
	if controlsAdapter, ok := r.options.Adapter.(types.ScopedHarnessSessionControls); ok {
		result.Controls = controlsAdapter.SessionControlsFor("room")
	}
	return result
}

// prepareTaskSession consumes one selection token exactly once and arms the
// EXACT prepared adoption pinned to the canonical Task requestId the Room
// already generated. Nothing is loaded here: the native session is loaded by
// the canonical Task's own serialized admission boundary, so session/new can
// never run for that scope first.
func (r *ResidentRuntime) prepareTaskSession(control *types.ResidentSessionControl) types.ResidentSessionResult {
	result := types.ResidentSessionResult{Kind: control.Kind, RequestID: control.RequestID}
	if control.TaskRequestID == "" || (control.SessionToken == "") == (control.ProjectToken == "") {
		result.Error = types.ResidentSessionErrorInvalid
		return result
	}
	if control.SessionToken == "" {
		return r.prepareNewTaskProject(control)
	}
	if !r.taskNativeControlSelectionAvailable(control.ModeID, control.ConfigOptions) {
		result.Error = types.ResidentSessionErrorControlUnavailable
		return result
	}
	now := time.Now().UnixMilli()
	r.mu.Lock()
	r.pruneTaskSessionCacheLocked(now)
	selection, found := r.taskSessionSessions[control.SessionToken]
	// Consume exactly once, before any other check: a token that was used may
	// never be replayed, even if arming then fails. Replaying a consumed token
	// would otherwise let one Human intent arm two different Tasks.
	delete(r.taskSessionSessions, control.SessionToken)
	r.mu.Unlock()
	if !found || selection.expiresAt <= now {
		result.Error = types.ResidentSessionErrorExpired
		return result
	}
	human := selection.humanParticipantID
	// A selection is bound to the EXACT Human who discovered it. Another
	// participant presenting the same handle is refused, and the token is
	// already consumed by that attempt, so it cannot be replayed either.
	if human == "" ||
		human != control.HumanParticipantID ||
		!r.sessionHumanIsCurrent(human) {
		result.Error = types.ResidentSessionErrorExpired
		return result
	}
	// session/list is discovery, not a lease on the local directory. Catch a
	// removed, missing, or non-directory cwd while the Human is still in the
	// picker flow so a known-unavailable project never becomes a Task that
	// immediately projects Session lost. Keep the exact string in the token;
	// this check must not clean, resolve, or substitute the path.
	if !taskSessionCwdAvailable(selection.cwd) {
		result.Error = types.ResidentSessionErrorProjectUnavailable
		r.log("task_session_prepare_failed", map[string]string{"failureClass": "CWD_PATH_UNAVAILABLE"})
		return result
	}
	if err := r.ArmPreparedSessionAdoptionWithControls(selection.sessionID, selection.cwd, human, control.TaskRequestID, control.ModeID, control.ConfigOptions); err != nil {
		result.Error = types.ResidentSessionErrorUnavailable
		r.log("task_session_prepare_failed", map[string]string{"failureClass": turnFailureClassOf(err)})
		return result
	}
	result.OK = true
	return result
}

func (r *ResidentRuntime) prepareNewTaskProject(control *types.ResidentSessionControl) types.ResidentSessionResult {
	result := types.ResidentSessionResult{Kind: control.Kind, RequestID: control.RequestID}
	if !r.taskNativeControlSelectionAvailable(control.ModeID, control.ConfigOptions) {
		result.Error = types.ResidentSessionErrorControlUnavailable
		return result
	}
	now := time.Now().UnixMilli()
	r.mu.Lock()
	r.pruneTaskSessionCacheLocked(now)
	project, found := r.taskSessionProjects[control.ProjectToken]
	r.mu.Unlock()
	if !found || project.expiresAt <= now || project.humanParticipantID != control.HumanParticipantID ||
		!r.sessionHumanIsCurrent(control.HumanParticipantID) {
		result.Error = types.ResidentSessionErrorExpired
		return result
	}
	if !taskSessionCwdAvailable(project.cwd) {
		result.Error = types.ResidentSessionErrorProjectUnavailable
		r.log("task_project_prepare_failed", map[string]string{"failureClass": "CWD_PATH_UNAVAILABLE"})
		return result
	}
	if err := r.ArmPreparedProjectTaskWithControls(project.cwd, control.HumanParticipantID, control.TaskRequestID, control.ModeID, control.ConfigOptions); err != nil {
		result.Error = types.ResidentSessionErrorUnavailable
		r.log("task_project_prepare_failed", map[string]string{"failureClass": turnFailureClassOf(err)})
		return result
	}
	result.OK = true
	return result
}

func (r *ResidentRuntime) taskNativeControlSelectionAvailable(modeID string, configOptions map[string]string) bool {
	if modeID == "" && len(configOptions) == 0 {
		return true
	}
	adapter, ok := r.options.Adapter.(types.ScopedHarnessSessionControls)
	if !ok {
		return false
	}
	controls := adapter.SessionControlsFor("room")
	if controls == nil {
		return false
	}
	if modeID != "" {
		found := false
		for _, mode := range controls.Modes {
			if mode.ID == modeID {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	for id, value := range configOptions {
		found := false
		for _, option := range controls.ConfigOptions {
			if option.ID != id || option.Type != "select" {
				continue
			}
			for _, advertised := range option.Options {
				if advertised.Value == value {
					found = true
					break
				}
			}
			break
		}
		if !found {
			return false
		}
	}
	return true
}

func taskSessionCwdAvailable(cwd string) bool {
	if cwd == "" {
		return false
	}
	info, err := os.Stat(cwd)
	return err == nil && info.IsDir()
}

// cancelTaskSession releases a prepared adoption whose canonical Task will now
// never exist. Correctness never depends on this arriving: the adoption is
// bounded by its own short TTL and can only ever bind to its own exact
// requestId.
func (r *ResidentRuntime) cancelTaskSession(control *types.ResidentSessionControl) types.ResidentSessionResult {
	result := types.ResidentSessionResult{Kind: control.Kind, RequestID: control.RequestID}
	r.mu.Lock()
	r.pruneTaskSessionCacheLocked(time.Now().UnixMilli())
	r.mu.Unlock()
	adoption := r.pendingAdoptionSnapshot()
	if adoption == nil || control.TaskRequestID == "" || adoption.taskRequestID != control.TaskRequestID {
		// Nothing to release. This is a no-op, not a failure: the Room's
		// best-effort cancel may legitimately race the adoption's own expiry.
		result.OK = true
		return result
	}
	if err := r.ClearSessionAdoption(); err != nil && !errors.Is(err, errSessionAdoptionNotArmed) {
		result.Error = types.ResidentSessionErrorUnavailable
		return result
	}
	result.OK = true
	return result
}

// filterTaskSessions drops Runtime-owned disposable sessions and deduplicates
// by Harness session identity.
//
// Filtering is path-aware: a session is hidden when its cwd is INSIDE the
// daemon-owned Free4Chat workspace root. A substring test would hide a
// legitimate user project whose name merely contains the same text, and it
// would also fail to hide a workspace reached through a symlinked parent.
func (r *ResidentRuntime) filterTaskSessions(sessions []harness.ACPSessionInfo) []harness.ACPSessionInfo {
	root := r.options.DisposableWorkspaceRoot
	out := make([]harness.ACPSessionInfo, 0, len(sessions))
	seen := make(map[string]struct{}, len(sessions))
	for _, info := range sessions {
		if pathWithinRoot(root, info.Cwd) {
			continue
		}
		if _, duplicate := seen[info.SessionID]; duplicate {
			continue
		}
		seen[info.SessionID] = struct{}{}
		out = append(out, info)
	}
	return out
}

// pruneTaskSessionCacheLocked drops every expired entry. It is called under
// r.mu on each request, so the cache can never grow past its bounds or hold a
// stale selection indefinitely.
func (r *ResidentRuntime) pruneTaskSessionCacheLocked(now int64) {
	for token, selection := range r.taskSessionSessions {
		if selection.expiresAt <= now {
			delete(r.taskSessionSessions, token)
		}
	}
	for token, project := range r.taskSessionProjects {
		if project.expiresAt <= now {
			delete(r.taskSessionProjects, token)
		}
	}
	for token, page := range r.taskSessionPages {
		if page.expires <= now {
			delete(r.taskSessionPages, token)
		}
	}
}

// resolvePageTokenLocked consumes one single-use pagination handle. A token
// that belongs to a different Human is treated exactly like an unknown one.
func (r *ResidentRuntime) resolvePageTokenLocked(token, human string) (taskSessionPage, *string, bool) {
	if token == "" {
		return taskSessionPage{}, nil, true
	}
	page, found := r.taskSessionPages[token]
	// A page token is single-use: consuming it here is what makes Load more
	// strictly explicit, with no possibility of replaying one page twice.
	delete(r.taskSessionPages, token)
	if !found || page.human != human {
		return taskSessionPage{}, nil, false
	}
	return page, page.cwd, true
}

// sessionResultContext bounds one reply write. A resident socket that cannot
// accept a control-plane result within this window is treated as unavailable;
// the Human's request simply times out and is retried.
func sessionResultContext() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), 10*time.Second)
}

func (r *ResidentRuntime) issueSessionTokenLocked(info harness.ACPSessionInfo, human string, now int64) (string, error) {
	if len(r.taskSessionSessions) >= taskSessionMaxSessionTokens {
		return "", errors.New("session token capacity reached")
	}
	token, err := newTaskSessionToken()
	if err != nil {
		return "", err
	}
	r.taskSessionSessions[token] = taskSessionSelection{
		sessionID:          info.SessionID,
		cwd:                info.Cwd,
		humanParticipantID: human,
		expiresAt:          now + taskSessionTokenTTL.Milliseconds(),
	}
	return token, nil
}

// issueProjectTokenLocked returns the stable token for one exact cwd,
// allocating a new one only when this cwd is not already in the catalog. The
// catalog is what makes the project selector stable across pages: a project
// discovered on page 1 keeps the same handle on page 3.
func (r *ResidentRuntime) issueProjectTokenLocked(cwd, human string, now int64, index map[string]string) (string, error) {
	if token, found := index[cwd]; found {
		return token, nil
	}
	if len(r.taskSessionProjects) >= taskSessionMaxProjectTokens {
		// The catalog is full. Reuse the existing entries rather than
		// evicting a label the Human may already be looking at.
		return "", errors.New("project token capacity reached")
	}
	token, err := newTaskSessionToken()
	if err != nil {
		return "", err
	}
	r.taskSessionProjects[token] = taskSessionProject{
		cwd:                cwd,
		label:              taskSessionProjectLabel(cwd),
		humanParticipantID: human,
		expiresAt:          now + taskSessionTokenTTL.Milliseconds(),
	}
	index[cwd] = token
	r.refreshTaskSessionProjectLabelsLocked()
	return token, nil
}

// refreshTaskSessionProjectLabelsLocked makes every display label a basename.
// Duplicate basenames receive a short suffix from their opaque Runtime token;
// no parent directory is consulted or relayed.
func (r *ResidentRuntime) refreshTaskSessionProjectLabelsLocked() {
	byBase := make(map[string][]string, len(r.taskSessionProjects))
	for token, project := range r.taskSessionProjects {
		byBase[taskSessionProjectLabel(project.cwd)] = append(byBase[taskSessionProjectLabel(project.cwd)], token)
	}
	for base, tokens := range byBase {
		if len(tokens) == 1 {
			project := r.taskSessionProjects[tokens[0]]
			project.label = base
			r.taskSessionProjects[tokens[0]] = project
			continue
		}
		for _, token := range tokens {
			project := r.taskSessionProjects[token]
			project.label = taskSessionProjectLabelWithToken(base, token, tokens)
			r.taskSessionProjects[token] = project
		}
	}
}

func (r *ResidentRuntime) issuePageTokenLocked(cwd *string, cursor string, pending []harness.ACPSessionInfo, human string, now int64) (string, error) {
	for len(r.taskSessionPages) >= taskSessionMaxPageTokens {
		// Evict the oldest handle rather than refusing a page the Human just
		// asked for. An evicted token simply reports selection_expired.
		oldestToken := ""
		oldestExpiry := int64(0)
		for token, page := range r.taskSessionPages {
			if oldestToken == "" || page.expires < oldestExpiry {
				oldestToken, oldestExpiry = token, page.expires
			}
		}
		delete(r.taskSessionPages, oldestToken)
	}
	token, err := newTaskSessionToken()
	if err != nil {
		return "", err
	}
	r.taskSessionPages[token] = taskSessionPage{
		cwd:     cwd,
		cursor:  cursor,
		pending: pending,
		human:   human,
		expires: now + taskSessionTokenTTL.Milliseconds(),
	}
	return token, nil
}

// projectCatalogLocked returns the bounded, Human-scoped project choices.
func (r *ResidentRuntime) projectCatalogLocked(human string, now int64) []types.ResidentTaskSessionProject {
	out := make([]types.ResidentTaskSessionProject, 0, len(r.taskSessionProjects))
	for token, project := range r.taskSessionProjects {
		if project.expiresAt <= now || project.humanParticipantID != human {
			continue
		}
		out = append(out, types.ResidentTaskSessionProject{Token: token, Label: project.label})
		if len(out) >= types.MaxResidentSessionProjects {
			break
		}
	}
	sortTaskSessionProjects(out)
	return out
}

// sessionHumanIsCurrent reports whether this Human participant is still in the
// current roster. A selection made by a participant who has left is never
// re-bound to a replacement participant.
func (r *ResidentRuntime) sessionHumanIsCurrent(participantID string) bool {
	if participantID == "" {
		return false
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, participant := range r.roster {
		if participant.ID == participantID {
			return participant.Kind == types.KindHuman
		}
	}
	return false
}

// pathWithinRoot reports whether candidate is root itself or lies inside it.
// It is deliberately lexical (filepath.Clean + filepath.Rel) with no
// filesystem access: discovery must never stat or walk a Harness-provided
// path, and a root that does not exist locally still filters correctly.
func pathWithinRoot(root, candidate string) bool {
	if strings.TrimSpace(root) == "" || candidate == "" {
		return false
	}
	cleanRoot := filepath.Clean(root)
	cleanCandidate := filepath.Clean(candidate)
	if !filepath.IsAbs(cleanRoot) || !filepath.IsAbs(cleanCandidate) {
		return false
	}
	relative, err := filepath.Rel(cleanRoot, cleanCandidate)
	if err != nil {
		return false
	}
	if relative == "." {
		return true
	}
	return relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}

// taskSessionProjectLabel returns only the final path component for display.
// Raw cwd is retained exclusively in the private Runtime token mapping.
func taskSessionProjectLabel(cwd string) string {
	base := filepath.Base(filepath.Clean(cwd))
	base = strings.NewReplacer("/", "", `\`, "").Replace(base)
	if base == "" || base == "." || base == string(filepath.Separator) {
		base = "Local project"
	}
	return boundedSessionText(base, types.MaxResidentSessionProjectLabelLength)
}

func taskSessionProjectLabelWithToken(base, token string, collisions []string) string {
	// Runtime-issued tokens are opaque random handles. Extend the prefix only
	// when needed to ensure labels remain distinct inside this catalog.
	length := 4
	for length < len(token) {
		candidate := token[:length]
		unique := true
		for _, other := range collisions {
			if other != token && strings.HasPrefix(other, candidate) {
				unique = false
				break
			}
		}
		if unique {
			break
		}
		length++
	}
	if length > len(token) {
		length = len(token)
	}
	return boundedSessionText(base+" · "+token[:length], types.MaxResidentSessionProjectLabelLength)
}

// boundedSessionText bounds and control-folds display-only text. A Harness
// title is untrusted presentation: it can contain arbitrary user or model
// text, so it is folded to one line and cut to a fixed length before it can
// reach a browser.
func boundedSessionText(value string, limit int) string {
	cleaned := strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return ' '
		}
		return r
	}, value)
	cleaned = strings.TrimSpace(cleaned)
	runes := []rune(cleaned)
	if len(runes) <= limit {
		return cleaned
	}
	return string(runes[:limit])
}

// newTaskSessionToken mints one cryptographically random opaque handle.
func newTaskSessionToken() (string, error) {
	buffer := make([]byte, taskSessionTokenBytes)
	if _, err := rand.Read(buffer); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buffer), nil
}

// sortTaskSessionProjects orders labels deterministically so the project
// selector does not reshuffle between two identical responses.
func sortTaskSessionProjects(projects []types.ResidentTaskSessionProject) {
	for i := 1; i < len(projects); i++ {
		for j := i; j > 0 && projects[j].Label < projects[j-1].Label; j-- {
			projects[j], projects[j-1] = projects[j-1], projects[j]
		}
	}
}
