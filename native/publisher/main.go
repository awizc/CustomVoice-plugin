package main

// Private stdin carries credentials once, then length-delimited H264 frames.
// stdout is a bounded JSON control stream; never log credentials or frame data.
import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/livekit/protocol/livekit"
	lksdk "github.com/livekit/server-sdk-go/v2"
	"github.com/pion/interceptor"
	"github.com/pion/interceptor/pkg/cc"
	"github.com/pion/interceptor/pkg/gcc"
	"github.com/pion/interceptor/pkg/twcc"
	"github.com/pion/rtcp"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"
)

type credentials struct {
	URL      string `json:"url"`
	Token    string `json:"token"`
	Identity string `json:"identity"`
	Owner    string `json:"owner"`
	Width    int    `json:"width"`
	Height   int    `json:"height"`
	FPS      int    `json:"fps"`
	Bitrate  int    `json:"bitrate"`
	Profile  string `json:"profile"`
}

var output sync.Mutex

func emit(v any) { output.Lock(); defer output.Unlock(); _ = json.NewEncoder(os.Stdout).Encode(v) }
func readCredentials(r *bufio.Reader) (c credentials, err error) {
	line, err := r.ReadSlice('\n')
	if err != nil {
		return c, errors.New("invalid initialization")
	}
	if len(line) > 16384 {
		return c, errors.New("initialization too large")
	}
	if err = json.Unmarshal(line, &c); err != nil {
		return c, errors.New("invalid initialization")
	}
	u, e := url.Parse(c.URL)
	if e != nil || u.Scheme != "wss" || u.Host == "" || u.User != nil || c.Identity == "" || c.Identity == c.Owner || c.Owner == "" || len(c.Token) > 12000 || len(c.Token) < 10 || c.Width < 2 || c.Width > 8192 || c.Height < 2 || c.Height > 8192 || c.FPS < 1 || c.FPS > 165 || c.Bitrate < 250000 || c.Bitrate > 100000000 || len(c.Profile) != 6 {
		return c, errors.New("invalid publisher configuration")
	}
	for _, ch := range c.Profile {
		if !strings.ContainsRune("0123456789abcdef", ch) {
			return c, errors.New("invalid H264 profile")
		}
	}
	return c, nil
}
func readFrame(r io.Reader) ([]byte, uint64, error) {
	var h [12]byte
	if _, err := io.ReadFull(r, h[:]); err != nil {
		return nil, 0, err
	}
	size := binary.LittleEndian.Uint32(h[:4])
	stamp := binary.LittleEndian.Uint64(h[4:])
	if size == 0 || size > 8*1024*1024 {
		return nil, 0, errors.New("invalid frame size")
	}
	frame := make([]byte, size)
	_, err := io.ReadFull(r, frame)
	return frame, stamp, err
}
func run() error {
	reader := bufio.NewReaderSize(os.Stdin, 16385)
	c, err := readCredentials(reader)
	if err != nil {
		return err
	}
	ccFactory, err := cc.NewInterceptor(func() (cc.BandwidthEstimator, error) {
		return gcc.NewSendSideBWE(gcc.SendSideBWEInitialBitrate(min(c.Bitrate, 4000000)), gcc.SendSideBWEMinBitrate(250000), gcc.SendSideBWEMaxBitrate(c.Bitrate), gcc.SendSideBWEPacer(newBoundedPacer(min(c.Bitrate, 4000000))))
	})
	if err != nil {
		return errors.New("congestion controller unavailable")
	}
	extension, err := twcc.NewHeaderExtensionInterceptor()
	if err != nil {
		return errors.New("transport feedback unavailable")
	}
	var target atomic.Int64
	target.Store(int64(min(c.Bitrate, 4000000)))
	ccFactory.OnNewPeerConnection(func(_ string, bwe cc.BandwidthEstimator) {
		bwe.OnTargetBitrateChange(func(rate int) { target.Store(int64(rate)) })
	})
	stop := make(chan struct{})
	var once sync.Once
	callbacks := lksdk.NewRoomCallback()
	callbacks.OnDisconnected = func() { once.Do(func() { close(stop) }); emit(map[string]any{"type": "disconnected"}) }
	// A separate publisher reconnect must not silently count discarded frames.
	// Let the browser fallback retain the voice room and resume video.
	callbacks.OnReconnecting = callbacks.OnDisconnected
	room, err := lksdk.ConnectToRoomWithToken(c.URL, c.Token, callbacks, lksdk.WithAutoSubscribe(false), lksdk.WithConnectTimeout(12*time.Second), lksdk.WithIncludeDefaultInterceptors(true), lksdk.WithInterceptors([]interceptor.Factory{ccFactory, extension}))
	c.Token = ""
	if err != nil {
		return errors.New("publisher connection failed")
	}
	defer room.Disconnect()
	if room.LocalParticipant.Identity() != c.Identity {
		return errors.New("publisher identity mismatch")
	}
	var keyframe atomic.Bool
	var sentFrames, sentBytes atomic.Int64
	track, err := lksdk.NewLocalSampleTrack(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeH264, ClockRate: 90000, SDPFmtpLine: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=" + c.Profile}, lksdk.WithRTCPHandler(func(packet rtcp.Packet) {
		switch packet.(type) {
		case *rtcp.PictureLossIndication, *rtcp.FullIntraRequest:
			keyframe.Store(true)
		}
	}))
	if err != nil {
		return errors.New("publisher track unavailable")
	}
	defer track.Close()
	publication, err := room.LocalParticipant.PublishTrack(track, &lksdk.TrackPublicationOptions{Name: "CustomVoice NVENC", Source: livekit.TrackSource_SCREEN_SHARE, VideoWidth: c.Width, VideoHeight: c.Height})
	if err != nil {
		return errors.New("publisher track refused")
	}
	emit(map[string]any{"type": "ready", "sid": publication.SID(), "identity": c.Identity})
	defer once.Do(func() { close(stop) })
	go func() {
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
				emit(map[string]any{"type": "feedback", "bitrate": target.Load(), "keyframe": keyframe.Swap(false), "sentFrames": sentFrames.Load(), "sentBytes": sentBytes.Load(), "timestamp": time.Now().UnixMilli()})
			}
		}
	}()
	var previous uint64
	waitingForIDR := true
	for {
		frame, stamp, err := readFrame(reader)
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		select {
		case <-stop:
			return errors.New("publisher disconnected")
		default:
		}
		if !track.IsBound() {
			keyframe.Store(true)
			waitingForIDR = true
			continue
		}
		if waitingForIDR {
			if !hasIDR(frame) {
				keyframe.Store(true)
				continue
			}
			waitingForIDR = false
		}
		duration := time.Second / time.Duration(c.FPS)
		if previous != 0 {
			if stamp <= previous {
				return errors.New("nonmonotonic frame timestamp")
			}
			duration = time.Duration(stamp-previous) * time.Microsecond
			if duration > time.Second {
				duration = time.Second
			}
		}
		previous = stamp
		if err = track.WriteSample(media.Sample{Data: frame, Duration: duration}, nil); err != nil {
			return errors.New("publisher send failed")
		}
		sentFrames.Add(1)
		sentBytes.Add(int64(len(frame)))
	}
}
func hasIDR(data []byte) bool {
	for i := 0; i+3 < len(data); i++ {
		if data[i] == 0 && data[i+1] == 0 && data[i+2] == 1 && data[i+3]&31 == 5 {
			return true
		}
	}
	return false
}
func main() {
	if err := run(); err != nil {
		emit(map[string]any{"type": "error", "message": fmt.Sprint(err)})
		os.Exit(1)
	}
}
