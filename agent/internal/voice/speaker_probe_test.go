package voice

import (
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/i365dev/free4chat/agent/internal/speech"
	"github.com/i365dev/free4chat/agent/internal/speech/doubao"
)

// TestSpeakerFullAudioProbe measures how many PCM bytes the sink receives
// for one long joke-like reply (gated by DOUBAO_PROBE, never in CI).
func TestSpeakerFullAudioProbe(t *testing.T) {
	if os.Getenv("DOUBAO_PROBE") != "1" {
		t.Skip("manual probe")
	}
	var bytesTotal atomic.Int64
	var events []string
	var mu sync.Mutex
	speaker := NewSpeaker(Options{
		Provider: &doubao.TtsProvider{APIKey: os.Getenv("DOUBAO_API_KEY")},
		CreateSink: func(uint64) (Sink, error) {
			return &countingSink{onWrite: func(n int) { bytesTotal.Add(int64(n)) }}, nil
		},
		MaxChunkChars: 220,
		OnEvent: func(e SpeakerEvent) {
			mu.Lock()
			events = append(events, e.Type)
			mu.Unlock()
		},
	})
	const joke = "厨师小王去相亲，女孩问：你平时最大的优点是什么？小王自信地说：我特别会照顾人，尤其擅长做饭。女孩眼睛一亮：那你最拿手的菜是什么？小王沉默了一会儿：番茄炒蛋。女孩有点失望：就这个？小王赶紧解释：这道菜看似简单，其实很考验功力。番茄要切得大小均匀，鸡蛋要炒得蓬松嫩滑，火候还要掌握得恰到好处。女孩听得越来越认真：没想到这么复杂。小王点点头：当然复杂。最关键的是——女孩追问：是什么？小王叹了口气：我每次都只能做出番茄炒蛋，不能做出蛋炒番茄。因为我女朋友每次都说：你要是再把鸡蛋放少一点，我就把你炒了。"
	speaker.Speak(joke)
	deadline := time.Now().Add(90 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		done := len(events) > 0 && events[len(events)-1] == "turnFinished"
		mu.Unlock()
		if done {
			break
		}
		time.Sleep(200 * time.Millisecond)
	}
	total := bytesTotal.Load()
	t.Logf("events=%v pcmBytes=%d (%.1fs @24k)", events, total, float64(total)/24000/2)
	_ = speaker.Close()
}

type countingSink struct{ onWrite func(int) }

func (s *countingSink) WriteAudio(c speech.TtsAudioChunk) error { s.onWrite(len(c.Data)); return nil }
func (s *countingSink) EndTurn() error                          { return nil }
func (s *countingSink) CancelTurn() error                       { return nil }
func (s *countingSink) Close() error                            { return nil }
