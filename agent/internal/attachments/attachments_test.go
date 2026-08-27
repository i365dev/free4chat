package attachments

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSurfaceMIMETypesFailClosed(t *testing.T) {
	for _, path := range []string{"snap.png", "snap.jpg", "snap.jpeg", "snap.webp"} {
		mime, err := SurfaceMIME(path)
		if err != nil {
			t.Fatalf("%s rejected: %v", path, err)
		}
		switch path {
		case "snap.png":
			if mime != "image/png" {
				t.Fatalf("png mime mismatch: %s", mime)
			}
		case "snap.jpg", "snap.jpeg":
			if mime != "image/jpeg" {
				t.Fatalf("jpeg mime mismatch: %s", mime)
			}
		case "snap.webp":
			if mime != "image/webp" {
				t.Fatalf("webp mime mismatch: %s", mime)
			}
		}
	}
	if _, err := SurfaceMIME("snap.gif"); err == nil {
		t.Fatal("gif must be rejected for surfaces")
	}
	if _, err := SurfaceMIME("snap.svg"); err == nil {
		t.Fatal("svg must be rejected for surfaces")
	}
}

func TestAttachmentMIMEFallbackChain(t *testing.T) {
	if got := AttachmentMIME("report.md", ""); got != "text/markdown" {
		t.Fatalf("md fallback mismatch: %s", got)
	}
	if got := AttachmentMIME("data.yaml", ""); got != "text/yaml" {
		t.Fatalf("yaml fallback mismatch: %s", got)
	}
	if got := AttachmentMIME("data.yml", ""); got != "text/yaml" {
		t.Fatalf("yml fallback mismatch: %s", got)
	}
	if got := AttachmentMIME("weird.bin", ""); got != "text/plain" {
		t.Fatalf("unknown extension must default to text/plain: %s", got)
	}
	if got := AttachmentMIME("photo.png", "application/octet-stream"); got != "application/octet-stream" {
		t.Fatalf("explicit --mime must win: %s", got)
	}
}

func TestReadBoundedEnforcesSize(t *testing.T) {
	dir := t.TempDir()
	empty := filepath.Join(dir, "empty.txt")
	if err := os.WriteFile(empty, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadBounded(empty, 100); err == nil {
		t.Fatal("empty files must be rejected")
	}

	big := filepath.Join(dir, "big.bin")
	if err := os.WriteFile(big, make([]byte, 1025), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadBounded(big, 1024); err == nil {
		t.Fatal("oversized files must be rejected")
	}

	ok := filepath.Join(dir, "ok.txt")
	if err := os.WriteFile(ok, []byte("hello"), 0o600); err != nil {
		t.Fatal(err)
	}
	data, err := ReadBounded(ok, 1024)
	if err != nil || string(data) != "hello" {
		t.Fatalf("bounded read mismatch: %q %v", data, err)
	}
}
