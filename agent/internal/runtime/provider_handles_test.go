package runtime

import (
	"encoding/json"
	"strings"
	"testing"

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
	claimHash   string
	joinProof   string
	updateProof string
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
