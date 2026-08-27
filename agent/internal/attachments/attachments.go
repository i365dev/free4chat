// Package attachments holds the small file-typing rules shared by the CLI:
// extension→MIME tables and the hard upload bounds mirroring the server
// surface policy (#111: image-only snapshot bounds, bounded ephemeral files).
package attachments

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
)

const (
	// MaxAttachmentBytes is the same image/text bound as the server policy.
	MaxAttachmentBytes = 768 * 1024
	// MaxSurfaceBytes applies to workspace snapshots (image-only).
	MaxSurfaceBytes = 768 * 1024
)

// SurfaceMIMEByExtension lists the only allowed snapshot types.
var surfaceMIMEByExtension = map[string]string{
	".png":  "image/png",
	".jpg":  "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
}

// MIMEByExtension drives local attachment typing; unknown types fall back to
// text/plain exactly like the Node CLI.
var mIMEByExtension = map[string]string{
	".png":  "image/png",
	".jpg":  "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".txt":  "text/plain",
	".md":   "text/markdown",
	".csv":  "text/csv",
	".json": "application/json",
	".yaml": "text/yaml",
	".yml":  "text/yaml",
}

// ExtensionOf extracts the lowercased suffix including the dot.
func ExtensionOf(path string) string {
	return strings.ToLower(filepath.Ext(path))
}

// SurfaceMIME resolves a surface snapshot type or fails closed.
func SurfaceMIME(path string) (string, error) {
	mimeType := surfaceMIMEByExtension[ExtensionOf(path)]
	if mimeType == "" {
		return "", errors.New("Surface snapshots must be a .png, .jpg/.jpeg, or .webp image")
	}
	return mimeType, nil
}

// AttachmentMIME resolves the attachment type: explicit --mime wins, then the
// extension table, then text/plain.
func AttachmentMIME(path, explicit string) string {
	if explicit != "" {
		return explicit
	}
	if mime := mIMEByExtension[ExtensionOf(path)]; mime != "" {
		return mime
	}
	return "text/plain"
}

// ReadBounded loads a non-empty file within max bytes.
func ReadBounded(path string, max int64) ([]byte, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() == 0 || info.Size() > max {
		return nil, errors.New("file must be a non-empty regular file within the size bound")
	}
	return os.ReadFile(path)
}
