// Package voice owns outbound Voice Reply text handling: deterministic
// phrase chunking and the FIFO speaker that turns TTS output into ordered
// sink writes with stale-turn cancellation.
package voice

import "strings"

// DefaultMaxChunkChars is the soft chunk cap before clause-level splitting.
const DefaultMaxChunkChars = 240

var sentenceEnders = map[rune]bool{
	'.': true, '!': true, '?': true, '…': true,
	'。': true, '！': true, '？': true, '；': true, ';': true,
}

var closers = map[rune]bool{
	'"': true, '\'': true, ')': true, ']': true, '}': true,
	'」': true, '』': true, '》': true, '»': true, '”': true, '’': true, '…': true,
}

var clauseBreaks = map[rune]bool{',': true, '，': true, '、': true, ':': true, '：': true}

var unconditionalEnders = map[rune]bool{'。': true, '！': true, '？': true, '；': true, '…': true}

// Chunker splits Harness response text into coherent spoken units
// (deterministic; the frozen Node createTextChunker semantics).
type Chunker struct {
	maxChars int
	buffer   []rune
}

// NewChunker builds a chunker (maxChars <= 0 uses the default).
func NewChunker(maxChars int) *Chunker {
	if maxChars <= 0 {
		maxChars = DefaultMaxChunkChars
	}
	return &Chunker{maxChars: maxChars}
}

// Push feeds text and returns every chunk now known to be complete.
func (c *Chunker) Push(text string) []string {
	if text != "" {
		c.buffer = append(c.buffer, []rune(text)...)
	}
	return c.extract(false)
}

// Flush emits whatever coherent remainder is still buffered.
func (c *Chunker) Flush() []string {
	chunks := c.extract(true)
	if trimmed := strings.TrimSpace(string(c.buffer)); trimmed != "" {
		chunks = append(chunks, trimmed)
	}
	c.buffer = nil
	return chunks
}

func (c *Chunker) extract(final bool) []string {
	var chunks []string
	start := 0
	searchFrom := start
	for {
		length := len(c.buffer) - start
		if length <= 0 {
			break
		}
		boundaryEnd := -1
		resumeAt := -1
		for i := searchFrom; i < len(c.buffer); i++ {
			ch := c.buffer[i]
			if ch == '\n' {
				boundaryEnd = i
				resumeAt = i + 1
				break
			}
			isEnder := sentenceEnders[ch]
			if isEnder && ch == '.' && i > start && isDigit(c.buffer[i-1]) && i+1 < len(c.buffer) && isDigit(c.buffer[i+1]) {
				continue
			}
			if !isEnder {
				continue
			}
			end := i + 1
			for end < len(c.buffer) {
				next := c.buffer[end]
				if !closers[next] && !sentenceEnders[next] {
					break
				}
				end++
			}
			if end < len(c.buffer) {
				unconditional := unconditionalEnders[ch]
				followedBySpace := c.buffer[end] == ' ' || c.buffer[end] == '\t'
				if !unconditional && !followedBySpace {
					searchFrom = i + 1
					continue
				}
				boundaryEnd = end
				resumeAt = end
			} else if final {
				boundaryEnd = end
				resumeAt = end
			} else {
				searchFrom = i + 1
				continue
			}
			break
		}
		if boundaryEnd < 0 && length > c.maxChars {
			windowEnd := start + c.maxChars
			clauseBreak := -1
			for i := start; i < windowEnd && i < len(c.buffer); i++ {
				if clauseBreaks[c.buffer[i]] {
					clauseBreak = i
				}
			}
			if clauseBreak >= 0 {
				boundaryEnd = clauseBreak + 1
				resumeAt = boundaryEnd
			} else {
				boundaryEnd = windowEnd
				resumeAt = windowEnd
			}
		}
		if boundaryEnd < 0 {
			break
		}
		raw := strings.TrimSpace(string(c.buffer[start:boundaryEnd]))
		if raw != "" {
			chunks = append(chunks, raw)
		}
		start = resumeAt
		for start < len(c.buffer) && isSpace(c.buffer[start]) {
			start++
		}
		searchFrom = start
	}
	c.buffer = c.buffer[start:]
	return chunks
}

func isDigit(ch rune) bool { return ch >= '0' && ch <= '9' }
func isSpace(ch rune) bool { return ch == ' ' || ch == '\t' || ch == '\n' || ch == '\r' }
