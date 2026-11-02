package main

import (
	"errors"
	"github.com/pion/interceptor"
	"github.com/pion/rtp"
	"sync"
	"time"
)

// Synchronous pacing propagates backpressure to the two-surface encoder pool.
// There is no unbounded RTP queue to grow during sustained congestion.
type boundedPacer struct {
	state   sync.Mutex
	send    sync.Mutex
	writers map[uint32]interceptor.RTPWriter
	rate    int
	next    time.Time
	done    chan struct{}
	once    sync.Once
}

func newBoundedPacer(rate int) *boundedPacer {
	return &boundedPacer{writers: make(map[uint32]interceptor.RTPWriter), rate: rate, done: make(chan struct{})}
}
func (p *boundedPacer) AddStream(ssrc uint32, w interceptor.RTPWriter) {
	p.state.Lock()
	p.writers[ssrc] = w
	p.state.Unlock()
}
func (p *boundedPacer) SetTargetBitrate(rate int) {
	p.state.Lock()
	p.rate = max(250000, rate)
	p.state.Unlock()
}
func (p *boundedPacer) Close() error { p.once.Do(func() { close(p.done) }); return nil }
func (p *boundedPacer) Write(header *rtp.Header, payload []byte, a interceptor.Attributes) (int, error) {
	p.send.Lock()
	defer p.send.Unlock()
	p.state.Lock()
	writer := p.writers[header.SSRC]
	rate := p.rate
	p.state.Unlock()
	if writer == nil {
		return 0, errors.New("unregistered RTP stream")
	}
	wait := time.Until(p.next)
	if wait > 0 {
		timer := time.NewTimer(min(wait, 100*time.Millisecond))
		select {
		case <-p.done:
			timer.Stop()
			return 0, errors.New("pacer closed")
		case <-timer.C:
		}
	}
	select {
	case <-p.done:
		return 0, errors.New("pacer closed")
	default:
	}
	// 20% transport/repair headroom, without replaying missed send deadlines.
	p.next = time.Now().Add(time.Duration(float64((header.MarshalSize()+len(payload))*8) * float64(time.Second) / (float64(rate) * 1.2)))
	return writer.Write(header, payload, a)
}
