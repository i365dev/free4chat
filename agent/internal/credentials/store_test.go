package credentials

import (
	"errors"
	"testing"
)

func TestDefaultStoreTestOptOutNeverUsesNativeStore(t *testing.T) {
	t.Setenv("FREE4CHAT_TEST_DISABLE_NATIVE_CREDENTIAL_STORE", "1")
	_, err := DefaultStore().Get("doubao", "apiKey")
	if !errors.Is(err, ErrUnavailable) {
		t.Fatalf("test opt-out did not disable native store: %v", err)
	}
}
