package runtime

import (
	"log"
	"os"
)

// logStderr is the process-wide lifecycle logger (stderr, like the Node
// reference's defaultLog). Never used for capability values.
var logStderr = log.New(os.Stderr, "", 0)
