package main

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"encoding/json"
	"github.com/pion/interceptor"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"
	"io"
	"testing"
	"time"
)

func TestCredentials(t *testing.T) {
	c := credentials{URL: "wss://media.test", Token: "a-private-token", Identity: "cv-screen:test", Owner: "voice", Width: 2560, Height: 1440, FPS: 165, Bitrate: 4000000, Profile: "42c03c"}
	parse := func() error {
		data, _ := json.Marshal(c)
		_, err := readCredentials(bufio.NewReaderSize(bytes.NewReader(append(data, '\n')), 16385))
		return err
	}
	if err := parse(); err != nil {
		t.Fatal(err)
	}
	c.Identity = c.Owner
	if parse() == nil {
		t.Fatal("duplicate voice identity accepted")
	}
	c.Identity = "cv-screen:test"
	c.URL = "ws://media.test"
	if parse() == nil {
		t.Fatal("insecure publisher accepted")
	}
}
func TestFrameBoundaries(t *testing.T) {
	var data bytes.Buffer
	_ = binary.Write(&data, binary.LittleEndian, uint32(4))
	_ = binary.Write(&data, binary.LittleEndian, uint64(1234))
	data.Write([]byte{0, 0, 1, 0x65})
	frame, stamp, err := readFrame(&data)
	if err != nil || stamp != 1234 || len(frame) != 4 {
		t.Fatal("bad frame", err)
	}
	if _, _, err = readFrame(&data); err != io.EOF {
		t.Fatal(err)
	}
	var invalid bytes.Buffer
	_ = binary.Write(&invalid, binary.LittleEndian, uint32(8388609))
	_ = binary.Write(&invalid, binary.LittleEndian, uint64(0))
	if _, _, err = readFrame(&invalid); err == nil {
		t.Fatal("unbounded frame")
	}
}

// No screen capture or remote service: negotiate H264 level 6 on two local
// peer connections and verify RTP reaches the receiving track.
func TestH264Loopback(t *testing.T) {
	sender, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer sender.Close()
	receiver, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer receiver.Close()
	track, err := webrtc.NewTrackLocalStaticSample(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeH264, ClockRate: 90000, SDPFmtpLine: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42c03c"}, "video", "test")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = sender.AddTrack(track); err != nil {
		t.Fatal(err)
	}
	received := make(chan bool, 1)
	receiver.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		packet, _, err := track.ReadRTP()
		if err == nil {
			received <- len(packet.Payload) > 0
		}
	})
	offer, err := sender.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	done := webrtc.GatheringCompletePromise(sender)
	if err = sender.SetLocalDescription(offer); err != nil {
		t.Fatal(err)
	}
	<-done
	if err = receiver.SetRemoteDescription(*sender.LocalDescription()); err != nil {
		t.Fatal(err)
	}
	answer, err := receiver.CreateAnswer(nil)
	if err != nil {
		t.Fatal(err)
	}
	done = webrtc.GatheringCompletePromise(receiver)
	if err = receiver.SetLocalDescription(answer); err != nil {
		t.Fatal(err)
	}
	<-done
	if err = sender.SetRemoteDescription(*receiver.LocalDescription()); err != nil {
		t.Fatal(err)
	}
	deadline := time.After(5 * time.Second)
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case ok := <-received:
			if !ok {
				t.Fatal("empty payload")
			}
			return
		case <-deadline:
			t.Fatal("H264 RTP did not reach receiver")
		case <-ticker.C:
			if err = track.WriteSample(media.Sample{Data: []byte{0, 0, 0, 1, 0x65, 1, 2, 3}, Duration: time.Second / 165}); err != nil {
				t.Fatal(err)
			}
		}
	}
}

func TestPacerBoundsAndCancellation(t *testing.T) {
	p := newBoundedPacer(250000)
	defer p.Close()
	sent := 0
	p.AddStream(1, interceptor.RTPWriterFunc(func(_ *rtp.Header, b []byte, _ interceptor.Attributes) (int, error) { sent++; return len(b), nil }))
	start := time.Now()
	for i := 0; i < 4; i++ {
		if _, err := p.Write(&rtp.Header{SSRC: 1}, make([]byte, 1200), nil); err != nil {
			t.Fatal(err)
		}
	}
	if sent != 4 || time.Since(start) < 60*time.Millisecond {
		t.Fatal("packet pacing did not apply backpressure")
	}
	p.Close()
	if _, err := p.Write(&rtp.Header{SSRC: 1}, []byte{1}, nil); err == nil {
		t.Fatal("closed pacer accepted packets")
	}
}
func TestIDRDetection(t *testing.T) {
	if !hasIDR([]byte{0, 0, 0, 1, 0x65, 1}) || hasIDR([]byte{0, 0, 1, 0x41, 1}) {
		t.Fatal("invalid recovery keyframe detection")
	}
}
