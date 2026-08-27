package daemon

import (
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/i365dev/free4chat/agent/internal/types"
)

// surfaceExtensionByMime is the fixed MIME→extension map (#111 review):
// local file extensions are never derived from remote-controlled strings.
var surfaceExtensionByMime = map[string]string{
	"image/jpeg": "jpg",
	"image/png":  "png",
	"image/webp": "webp",
}

const maxSurfaceBytes = 768 * 1024

// writeSurfaceSnapshot validates and persists a peer's snapshot into the
// instance workspace: decoded bytes must be non-empty, within the bound, and
// EXACTLY metadata.size — otherwise nothing is written.
func writeSurfaceSnapshot(workspace string, read types.SurfaceReadResult) (string, error) {
	if workspace == "" {
		return "", errors.New("instance workspace unavailable")
	}
	extension := surfaceExtensionByMime[read.Surface.MimeType]
	if extension == "" {
		return "", fmt.Errorf("Unsupported surface MIME %s", read.Surface.MimeType)
	}
	decoded, err := base64.StdEncoding.DecodeString(read.Data)
	if err != nil {
		return "", errors.New("Surface payload failed size validation; no file was written")
	}
	if len(decoded) == 0 || len(decoded) > maxSurfaceBytes ||
		int64(len(decoded)) != read.Surface.Size {
		return "", errors.New("Surface payload failed size validation; no file was written")
	}
	surfacesDir := filepath.Join(workspace, "surfaces")
	if err := os.MkdirAll(surfacesDir, 0o700); err != nil {
		return "", err
	}
	localPath := filepath.Join(surfacesDir, fmt.Sprintf("%s.%s", read.Surface.SnapshotID, extension))
	if err := os.WriteFile(localPath, decoded, 0o600); err != nil {
		return "", err
	}
	return localPath, nil
}
