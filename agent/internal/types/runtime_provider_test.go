package types

import "testing"

func TestDeriveRuntimeProviderClaimHashCrossLanguageVector(t *testing.T) {
	got, err := DeriveRuntimeProviderClaimHash(
		"room-176-provider",
		"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
	)
	if err != nil {
		t.Fatal(err)
	}
	const want = "KPvm-f4hBdYhSjdaYF_67xqPZx7BiiAXvMo1U_8l44w"
	if got != want {
		t.Fatalf("claim hash mismatch: got %q want %q", got, want)
	}
}

func TestRuntimeProviderCredentialValidation(t *testing.T) {
	if !ValidRuntimeProviderCredential("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8") {
		t.Fatal("valid 256-bit base64url credential rejected")
	}
	for _, invalid := range []string{"", "not-a-secret", "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="} {
		if ValidRuntimeProviderCredential(invalid) {
			t.Fatalf("invalid credential accepted: %q", invalid)
		}
	}
}
