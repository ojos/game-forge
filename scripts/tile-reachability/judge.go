package main

// judge.go — 取り出した地図で、面ごとにスタート → カギ → ゴールへ届くかを BFS で見る（#675）。
//
// 見るもの（面ごと）:
//
//   - スタート → カギ: 扉を閉じたまま届くか（カギのマスが壁なら届かない）
//   - カギ → ゴール: カギを取った状態（扉の座標のマスが開いた状態）で届くか
//   - 扉を閉じたまま、スタート → ゴール: 届くなら「扉は飾り」（道を塞いでいない）
//
// 動けるマスは上下左右の 4 方向。壁の定数のマスは常に塞がる。扉の定数のマスと扉の座標のマスは、
// 閉じているときは塞がり、開けたときは**扉の座標のマスだけ**が通れる（カギを取ったときに扉の座標だけを
// 床へ書き換える作り。3 版とも同じ）。当たり判定の端での到達（#644 の px > 316 の形）はタイルの探索では
// 見えない（issue の scope.out）。

import "fmt"

// Room は 1 面の判定である。座標は (列, 行)。
type Room struct {
	Room  int     `json:"room"` // 1 から
	Start [2]int  `json:"start"`
	Key   [2]int  `json:"key"`
	Exit  [2]int  `json:"exit"`
	Door  *[2]int `json:"door,omitempty"`

	StartBlocked bool `json:"startBlocked"` // スタートのマスが塞がっている
	KeyOnWall    bool `json:"keyOnWall"`    // カギのマスが塞がっている
	ExitOnWall   bool `json:"exitOnWall"`   // ゴールのマスが（扉を開けても）塞がっている

	KeyReachable         bool  `json:"keyReachable"`
	ExitReachableWithKey bool  `json:"exitReachableWithKey"`
	ExitReachableClosed  *bool `json:"exitReachableDoorClosed,omitempty"` // 扉が無い作品では出さない
	// カギに届かない面で、仮にカギを持っていたら（扉を開けた状態で）スタートからゴールへ届くか。
	// 「カギだけが悪いのか、ゴールの区画も閉じているのか」を分けて読むために出す。
	ExitReachableIfKey bool `json:"exitReachableIfKey"`
	// 扉を閉じたままスタートから届くマスの数（閉じ込められているかを読むため）。
	StartArea int `json:"startArea"`

	Playable       bool `json:"playable"`       // カギにもゴールにも届く
	DoorDecorative bool `json:"doorDecorative"` // 扉を閉じたままゴールへ届く（扉は飾り）
}

// Judge は取り出した値から面ごとの判定を作る。値の形が合わないときは *SkipError を返す。
func Judge(ex *Extracted) ([]Room, error) {
	n := len(ex.Maps)
	if n == 0 {
		return nil, skipf("地図の面が 0 個")
	}
	rows := len(ex.Maps[0])
	if rows == 0 || len(ex.Maps[0][0]) == 0 {
		return nil, skipf("地図の大きさが 0")
	}
	cols := len(ex.Maps[0][0])

	wall, ok := ex.Tiles["wall"]
	if !ok {
		return nil, skipf("壁のタイルの値が無い")
	}
	doorTile, hasDoorTile := ex.Tiles["door"]
	floor, hasFloor := ex.Tiles["floor"]
	if !hasFloor {
		floor = 0
	}
	for r, m := range ex.Maps {
		for y, row := range m {
			for x, t := range row {
				if t != wall && t != floor && !(hasDoorTile && t == doorTile) {
					return nil, skipf("面 %d の (%d,%d) に、壁・扉・床のどれでもないタイルの値 %d がある（意味を決められない）", r+1, x, y, t)
				}
			}
		}
	}

	coord := func(roleName string, room int) ([2]int, bool, error) {
		cs, ok := ex.Coords[roleName]
		if !ok {
			return [2]int{}, false, nil
		}
		if len(cs) != n {
			return [2]int{}, false, skipf("%s の座標の数（%d）が面の数（%d）と合わない", roleName, len(cs), n)
		}
		c := cs[room]
		if len(c) != 2 {
			return [2]int{}, false, skipf("%s の座標の形が (列, 行) でない", roleName)
		}
		p := [2]int{c[0], c[1]}
		if ex.Order[roleName] == "yx" {
			p = [2]int{c[1], c[0]}
		}
		if p[0] < 0 || p[0] >= cols || p[1] < 0 || p[1] >= rows {
			return [2]int{}, false, skipf("面 %d の%sの座標 (%d,%d) が地図（%d×%d）の外", room+1, roleName, p[0], p[1], cols, rows)
		}
		return p, true, nil
	}

	// スタート: 配列が無ければ、画素の代入から取った 1 点を全部の面に使う。
	var pixelStart *[2]int
	if _, ok := ex.Coords["start"]; !ok {
		if len(ex.Starts) == 0 || ex.TileSize <= 0 {
			return nil, skipf("スタートの座標が無い")
		}
		var first [2]int
		for i, s := range ex.Starts {
			t := [2]int{int(s[0] / ex.TileSize), int(s[1] / ex.TileSize)}
			if s[0] < 0 || s[1] < 0 {
				return nil, skipf("スタートの画素 (%g,%g) が負", s[0], s[1])
			}
			if i == 0 {
				first = t
			} else if t != first {
				return nil, skipf("自機の位置への代入が 2 通りある（(%d,%d) と (%d,%d)）。どの面のスタートか決められない", first[0], first[1], t[0], t[1])
			}
		}
		if first[0] >= cols || first[1] >= rows {
			return nil, skipf("スタート (%d,%d) が地図（%d×%d）の外", first[0], first[1], cols, rows)
		}
		pixelStart = &first
	}

	var rooms []Room
	for r := 0; r < n; r++ {
		m := ex.Maps[r]
		if len(m) != rows {
			return nil, skipf("面 %d の行の数が他の面と違う", r+1)
		}
		for _, row := range m {
			if len(row) != cols {
				return nil, skipf("面 %d の列の数がそろっていない", r+1)
			}
		}
		key, _, err := coord("key", r)
		if err != nil {
			return nil, err
		}
		exit, _, err := coord("exit", r)
		if err != nil {
			return nil, err
		}
		door, hasDoor, err := coord("door", r)
		if err != nil {
			return nil, err
		}
		var start [2]int
		if pixelStart != nil {
			start = *pixelStart
		} else if start, _, err = coord("start", r); err != nil {
			return nil, err
		}

		passable := func(p [2]int, doorOpen bool) bool {
			t := m[p[1]][p[0]]
			if t == wall {
				return false
			}
			if hasDoor && p == door {
				return doorOpen
			}
			if hasDoorTile && t == doorTile {
				return false
			}
			return true
		}
		reach := func(from [2]int, doorOpen bool) map[[2]int]bool {
			seen := map[[2]int]bool{}
			if !passable(from, doorOpen) {
				return seen
			}
			queue := [][2]int{from}
			seen[from] = true
			for len(queue) > 0 {
				p := queue[0]
				queue = queue[1:]
				for _, d := range [][2]int{{1, 0}, {-1, 0}, {0, 1}, {0, -1}} {
					q := [2]int{p[0] + d[0], p[1] + d[1]}
					if q[0] < 0 || q[0] >= cols || q[1] < 0 || q[1] >= rows || seen[q] || !passable(q, doorOpen) {
						continue
					}
					seen[q] = true
					queue = append(queue, q)
				}
			}
			return seen
		}

		room := Room{
			Room:         r + 1,
			Start:        start,
			Key:          key,
			Exit:         exit,
			StartBlocked: !passable(start, false),
			KeyOnWall:    !passable(key, false),
			ExitOnWall:   !passable(exit, true),
		}
		closed := reach(start, false)
		room.StartArea = len(closed)
		room.KeyReachable = closed[key]
		room.ExitReachableIfKey = reach(start, true)[exit]
		if room.KeyReachable {
			room.ExitReachableWithKey = reach(key, true)[exit]
		}
		if hasDoor {
			d := door
			room.Door = &d
			c := closed[exit]
			room.ExitReachableClosed = &c
			room.DoorDecorative = c
		}
		room.Playable = room.KeyReachable && room.ExitReachableWithKey
		rooms = append(rooms, room)
	}
	return rooms, nil
}

// Describe は 1 面の判定を 1 行の文にする。
func (r Room) Describe() string {
	yes := func(b bool) string {
		if b {
			return "届く"
		}
		return "届かない"
	}
	s := fmt.Sprintf("面 %d: スタート(%d,%d)（届くマス %d）→ カギ(%d,%d): %s", r.Room, r.Start[0], r.Start[1], r.StartArea, r.Key[0], r.Key[1], yes(r.KeyReachable))
	switch {
	case r.StartBlocked:
		s += "（スタートのマスが塞がっている）"
	case r.KeyOnWall:
		s += "（カギが壁のマスの上）"
	}
	if r.KeyReachable {
		s += fmt.Sprintf(" / カギ → ゴール(%d,%d): %s", r.Exit[0], r.Exit[1], yes(r.ExitReachableWithKey))
	} else {
		ifKey := "仮にカギを持っていても届かない"
		if r.ExitReachableIfKey {
			ifKey = "仮にカギを持っていれば届く"
		}
		s += fmt.Sprintf(" / カギ → ゴール(%d,%d): —（カギに届かない。%s）", r.Exit[0], r.Exit[1], ifKey)
	}
	if r.ExitOnWall {
		s += "（ゴールのマスが塞がっている）"
	}
	if r.Door != nil {
		switch {
		case r.DoorDecorative:
			s += fmt.Sprintf(" / 扉(%d,%d) を閉じたまま → ゴール: 届く（扉は飾り。道を塞いでいない）", r.Door[0], r.Door[1])
		case r.ExitReachableIfKey:
			s += fmt.Sprintf(" / 扉(%d,%d) を閉じたまま → ゴール: 届かない（扉が道を塞いでいる）", r.Door[0], r.Door[1])
		default:
			s += fmt.Sprintf(" / 扉(%d,%d): 開けてもゴールに届かないので、塞いでいるかは読めない", r.Door[0], r.Door[1])
		}
	}
	return s
}
