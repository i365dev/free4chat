package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"strings"
)

type request struct {
	ID     string `json:"id"`
	Method string `json:"method"`
}

func main() {
	if len(os.Args) < 2 {
		os.Exit(2)
	}
	source := os.Args[1]
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 1024), 64*1024)
	for scanner.Scan() {
		var input request
		if json.Unmarshal(scanner.Bytes(), &input) != nil {
			os.Exit(3)
		}
		if source == "crash-on-observe" && input.Method == "observe" {
			os.Exit(6)
		}
		var result string
		switch input.Method {
		case "list":
			if source == "zero" {
				result = `[]`
			} else if source == "multi" {
				result = `[` + descriptor + `,` + descriptor + `]`
			} else {
				result = `[` + descriptor + `]`
			}
		case "describe":
			result = descriptor
		case "observe":
			encoded, _ := json.Marshal(map[string]string{"source": source})
			result = string(encoded)
		case "invoke":
			result = `{"ok":true}`
		default:
			os.Exit(4)
		}
		fmt.Printf(`{"protocolVersion":1,"id":%q,"result":%s}`+"\n", input.ID, result)
		if source == "duplicate" && input.Method == "list" {
			fmt.Printf(`{"protocolVersion":1,"id":%q,"result":%s}`+"\n", input.ID, result)
		}
		if source == "stderr-secret" {
			fmt.Fprintln(os.Stderr, "Adapter stderr sentinel must remain local")
		}
		if strings.Contains(source, "exit-on-list") && input.Method == "list" {
			os.Exit(0)
		}
	}
}

const descriptor = `{"capabilityId":"test_light","title":"Test light","version":"1","observe":true,"actions":[{"name":"turn_on","title":"Turn on","input":{"type":"object","properties":{"on":"boolean"},"required":["on"]}}]}`
