package generatedapp

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"strings"

	"golang.org/x/net/html"
)

const maxAuthoringHTMLBytes = MaxBundleBytes

var errInvalidAuthoringHTML = errors.New("generated App HTML authoring input is invalid")

// NormalizeHTML converts the narrow Agent-facing HTML authoring format into
// the existing internal GeneratedRoomAppBundle V1 contract. The HTML5 parser
// is used for structure and serialization; source extraction is never done
// with regular expressions.
func NormalizeHTML(source string) (map[string]any, error) {
	if len(source) == 0 || len(source) > maxAuthoringHTMLBytes || strings.ContainsRune(source, '\x00') {
		return nil, errInvalidAuthoringHTML
	}

	explicitTags, err := countExplicitDocumentTags(source)
	if err != nil || explicitTags["html"] != 1 || explicitTags["head"] != 1 || explicitTags["body"] != 1 {
		return nil, errInvalidAuthoringHTML
	}

	document, err := html.Parse(strings.NewReader(source))
	if err != nil {
		return nil, errInvalidAuthoringHTML
	}
	htmlNode, ok := oneElement(document, "html")
	if !ok || htmlNode.Parent != document {
		return nil, errInvalidAuthoringHTML
	}
	headNode, ok := oneElement(htmlNode, "head")
	if !ok || headNode.Parent != htmlNode {
		return nil, errInvalidAuthoringHTML
	}
	bodyNode, ok := oneElement(htmlNode, "body")
	if !ok || bodyNode.Parent != htmlNode {
		return nil, errInvalidAuthoringHTML
	}
	titleNode, ok := oneElement(document, "title")
	if !ok || titleNode.Parent != headNode {
		return nil, errInvalidAuthoringHTML
	}
	title := strings.TrimSpace(textContent(titleNode))
	if title == "" || len(title) > 80 || !titlePattern.MatchString(title) {
		return nil, errInvalidAuthoringHTML
	}

	var styles []string
	var scripts []*html.Node
	if !collectAuthoringNodes(document, headNode, &styles, &scripts) {
		return nil, errInvalidAuthoringHTML
	}
	if len(scripts) > 1 {
		return nil, errInvalidAuthoringHTML
	}

	var scriptSource string
	if len(scripts) == 1 {
		script := scripts[0]
		if script.Parent != bodyNode || !isFinalMeaningfulChild(script) || !classicInlineScript(script) {
			return nil, errInvalidAuthoringHTML
		}
		scriptSource = textContent(script)
	}

	var body bytes.Buffer
	for child := bodyNode.FirstChild; child != nil; child = child.NextSibling {
		if len(scripts) == 1 && child == scripts[0] {
			continue
		}
		if err := html.Render(&body, child); err != nil {
			return nil, errInvalidAuthoringHTML
		}
	}
	css := strings.Join(styles, "\n")
	if css == "" {
		css = "/* no app styles */"
	}
	if scriptSource == "" {
		scriptSource = "/* no app script */"
	}

	bundle := map[string]any{
		"version": float64(1),
		"manifest": map[string]any{
			"title":          title,
			"networkOrigins": []any{},
		},
		"html":         body.String(),
		"css":          css,
		"js":           scriptSource,
		"initialState": map[string]any{},
	}
	encoded, err := json.Marshal(bundle)
	if err != nil || Validate(encoded, bundle) != nil {
		return nil, errInvalidAuthoringHTML
	}
	return bundle, nil
}

func countExplicitDocumentTags(source string) (map[string]int, error) {
	tokenizer := html.NewTokenizer(strings.NewReader(source))
	counts := map[string]int{"html": 0, "head": 0, "body": 0}
	for {
		tokenType := tokenizer.Next()
		if tokenType == html.ErrorToken {
			if err := tokenizer.Err(); err != nil && !errors.Is(err, io.EOF) {
				return nil, err
			}
			return counts, nil
		}
		if tokenType != html.StartTagToken && tokenType != html.SelfClosingTagToken {
			continue
		}
		name, _ := tokenizer.TagName()
		switch string(name) {
		case "html", "head", "body":
			counts[string(name)]++
		}
	}
}

func oneElement(root *html.Node, tag string) (*html.Node, bool) {
	var found *html.Node
	count := 0
	var walk func(*html.Node)
	walk = func(node *html.Node) {
		if node.Type == html.ElementNode && node.Data == tag {
			found = node
			count++
		}
		for child := node.FirstChild; child != nil; child = child.NextSibling {
			walk(child)
		}
	}
	walk(root)
	return found, count == 1
}

func collectAuthoringNodes(node, head *html.Node, styles *[]string, scripts *[]*html.Node) bool {
	if node.Type == html.ElementNode {
		switch node.Data {
		case "style":
			if node.Parent != head || !inlineStyle(node) {
				return false
			}
			*styles = append(*styles, textContent(node))
		case "script":
			*scripts = append(*scripts, node)
		case "link", "base":
			return false
		}
		if hasExternalResourceAttribute(node) || isMetaRefresh(node) {
			return false
		}
	}
	for child := node.FirstChild; child != nil; child = child.NextSibling {
		if !collectAuthoringNodes(child, head, styles, scripts) {
			return false
		}
	}
	return true
}

func inlineStyle(node *html.Node) bool {
	for _, attr := range node.Attr {
		if attr.Key != "type" || (attr.Val != "" && !strings.EqualFold(strings.TrimSpace(attr.Val), "text/css")) {
			return false
		}
	}
	return true
}

func classicInlineScript(node *html.Node) bool {
	for _, attr := range node.Attr {
		switch attr.Key {
		case "type":
			if attr.Val != "" && !strings.EqualFold(strings.TrimSpace(attr.Val), "text/javascript") {
				return false
			}
		default:
			// Keeping the executable element attribute-free avoids external,
			// deferred, module, or otherwise altered execution modes in V1.
			return false
		}
	}
	return true
}

func isFinalMeaningfulChild(script *html.Node) bool {
	for node := script.NextSibling; node != nil; node = node.NextSibling {
		switch node.Type {
		case html.CommentNode:
			continue
		case html.TextNode:
			if strings.TrimSpace(node.Data) == "" {
				continue
			}
		}
		return false
	}
	return true
}

func hasExternalResourceAttribute(node *html.Node) bool {
	for _, attr := range node.Attr {
		switch attr.Key {
		case "src":
			if node.Data == "img" && strings.HasPrefix(strings.ToLower(strings.TrimSpace(attr.Val)), "data:image/") {
				continue
			}
			return true
		case "srcset", "poster", "data", "action", "formaction", "xlink:href":
			return true
		case "href":
			if node.Data == "a" && strings.HasPrefix(strings.TrimSpace(attr.Val), "#") {
				continue
			}
			return true
		}
	}
	return false
}

func isMetaRefresh(node *html.Node) bool {
	if node.Type != html.ElementNode || node.Data != "meta" {
		return false
	}
	for _, attr := range node.Attr {
		if attr.Key == "http-equiv" && strings.EqualFold(strings.TrimSpace(attr.Val), "refresh") {
			return true
		}
	}
	return false
}

func textContent(node *html.Node) string {
	var text strings.Builder
	var walk func(*html.Node)
	walk = func(current *html.Node) {
		if current.Type == html.TextNode {
			text.WriteString(current.Data)
		}
		for child := current.FirstChild; child != nil; child = child.NextSibling {
			walk(child)
		}
	}
	walk(node)
	return text.String()
}
