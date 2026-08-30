package runtime

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/i365dev/free4chat/agent/internal/free4chat"
	"github.com/i365dev/free4chat/agent/internal/types"
)

func TestProviderHandleStoreIsRoomAndHostScoped(t *testing.T) {
	store := NewProviderHandleStore()
	handle := "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
	store.Put("room-a", "host-a", handle)
	if got := store.Get("room-a", "host-a"); got != handle {
		t.Fatalf("stored handle mismatch: %q", got)
	}
	if got := store.Get("room-a", "host-b"); got != "" {
		t.Fatalf("handle crossed Host boundary: %q", got)
	}
	if got := store.Get("room-b", "host-a"); got != "" {
		t.Fatalf("handle crossed Room boundary: %q", got)
	}
	store.Delete("room-a", "host-a")
	if got := store.Get("room-a", "host-a"); got != "" {
		t.Fatalf("handle survived delete: %q", got)
	}
}

type providerJoinClient struct {
	*fakeClient
	claimHash         string
	joinProof         string
	updateProof       string
	providerUpdates   int
	plainUpdates      int
	providerUpdateErr error
}

func (c *providerJoinClient) JoinRoomWithRuntimeProvider(_ string, _ string, _ []string, _ *types.RuntimeHostProjection, claimHash, providerHandle string) (types.JoinResult, error) {
	c.claimHash = claimHash
	c.joinProof = providerHandle
	return types.JoinResult{
		ParticipantID:         "agent-provider",
		ParticipantHandle:     "participant-provider-handle",
		RuntimeProviderHandle: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
		ExpiresAt:             99,
	}, nil
}

func (c *providerJoinClient) UpdateRuntimeHostWithRuntimeProvider(_ string, _ types.RuntimeHostProjection, providerHandle string) error {
	c.updateProof = providerHandle
	c.providerUpdates++
	return c.providerUpdateErr
}

func (c *providerJoinClient) UpdateRuntimeHost(_ string, _ types.RuntimeHostProjection) error {
	c.plainUpdates++
	return nil
}

func TestRuntimeRedeemsClaimOnceThenSharesOnlyPrivateHandle(t *testing.T) {
	store := NewProviderHandleStore()
	client := &providerJoinClient{fakeClient: &fakeClient{}}
	const claimSecret = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
	rt := NewResidentRuntime(Options{
		RoomID:          "room-176-provider",
		Name:            "Pi",
		Client:          client,
		Adapter:         &fakeAdapter{name: "test"},
		HostSeed:        "host-seed-176",
		ProviderClaim:   claimSecret,
		ProviderHandles: store,
	})
	if err := rt.join(); err != nil {
		t.Fatal(err)
	}
	const wantClaimHash = "KPvm-f4hBdYhSjdaYF_67xqPZx7BiiAXvMo1U_8l44w"
	if client.claimHash != wantClaimHash || client.joinProof != "" {
		t.Fatalf("claim redemption wire mismatch: claim=%q proof=%q", client.claimHash, client.joinProof)
	}
	host := rt.CurrentHostProjection()
	if host == nil {
		t.Fatal("expected Runtime Host projection")
	}
	if got := store.Get("room-176-provider", host.RuntimeHostID); got == "" {
		t.Fatal("redeemed provider handle was not held in daemon memory")
	}
	if rt.providerClaim != "" {
		t.Fatal("raw one-time claim remained resident after redemption")
	}
	rt.projectRuntimeHost(rt.currentHandle())
	if client.updateProof == "" {
		t.Fatal("bound Host projection did not prove its private provider handle")
	}
	status, err := json.Marshal(rt.Status())
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(status), claimSecret) || strings.Contains(string(status), client.updateProof) {
		t.Fatalf("private provider capability escaped Runtime status: %s", status)
	}
}

func TestRuntimeDropsInvalidProviderHandleThenProjectsUnboundOnce(t *testing.T) {
	store := NewProviderHandleStore()
	client := &providerJoinClient{
		fakeClient: &fakeClient{},
		providerUpdateErr: &free4chat.Error{
			Code: free4chat.CodeRuntimeProviderHandleInvalid,
		},
	}
	rt := NewResidentRuntime(Options{
		RoomID:          "room-176-provider",
		Name:            "Pi",
		Client:          client,
		Adapter:         &fakeAdapter{name: "test"},
		HostSeed:        "host-seed-176",
		ProviderHandles: store,
	})
	host := rt.CurrentHostProjection()
	if host == nil {
		t.Fatal("expected Runtime Host projection")
	}
	const staleHandle = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
	store.Put("room-176-provider", host.RuntimeHostID, staleHandle)

	rt.projectRuntimeHost("participant-provider-handle")

	if client.updateProof != staleHandle || client.providerUpdates != 1 {
		t.Fatalf("stale proof update calls = %d, proof = %q", client.providerUpdates, client.updateProof)
	}
	if client.plainUpdates != 1 {
		t.Fatalf("ordinary fallback calls = %d, want 1", client.plainUpdates)
	}
	if got := store.Get("room-176-provider", host.RuntimeHostID); got != "" {
		t.Fatalf("stale provider handle remained in daemon memory: %q", got)
	}
}

func TestRuntimeRetainsProviderHandleForNonInvalidProviderErrors(t *testing.T) {
	for _, code := range []free4chat.ErrorCode{
		free4chat.CodeRuntimeProviderProofRequired,
		free4chat.CodeTransient,
	} {
		t.Run(string(code), func(t *testing.T) {
			store := NewProviderHandleStore()
			client := &providerJoinClient{
				fakeClient: &fakeClient{},
				providerUpdateErr: &free4chat.Error{
					Code: code,
				},
			}
			rt := NewResidentRuntime(Options{
				RoomID:          "room-176-provider",
				Name:            "Pi",
				Client:          client,
				Adapter:         &fakeAdapter{name: "test"},
				HostSeed:        "host-seed-176",
				ProviderHandles: store,
				Log:             func(string, map[string]string) {},
			})
			host := rt.CurrentHostProjection()
			if host == nil {
				t.Fatal("expected Runtime Host projection")
			}
			const providerHandle = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
			store.Put("room-176-provider", host.RuntimeHostID, providerHandle)

			rt.projectRuntimeHost("participant-provider-handle")

			if client.providerUpdates != 1 || client.plainUpdates != 0 {
				t.Fatalf("provider/plain calls = %d/%d, want 1/0", client.providerUpdates, client.plainUpdates)
			}
			if got := store.Get("room-176-provider", host.RuntimeHostID); got != providerHandle {
				t.Fatalf("non-invalid error discarded provider handle: %q", got)
			}
		})
	}
}
