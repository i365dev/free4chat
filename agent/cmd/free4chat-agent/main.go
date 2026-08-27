// Command free4chat-agent is the native Go Agent Runtime entrypoint.
package main

import (
	"os"

	"github.com/i365dev/free4chat/agent/internal/cli"
)

func main() {
	os.Exit(cli.Main(os.Args[1:]))
}
