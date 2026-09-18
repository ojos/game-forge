package main

// extract.go — 生成物の Go ソースから、地図と座標を「地図を組み立てるコードを実際に動かして」取り出す（#675）。
//
// 流れ:
//
//  1. go/ast で候補を探して結び付ける（地図の配列・座標の配列・地図を組み立てる関数・タイルの定数・
//     スタートの座標）。**候補が 0 個か 2 個以上なら「判定しない」**（推測で選ばない）。
//  2. 地図を組み立てる関数から参照をたどり、要る宣言だけを抜き出す（ゲームループ・描画・音・main は入らない）。
//     たどった先の import が許可リスト（allowedImports）の外なら「判定しない」。ebiten・os・net・math/rand・
//     time などへ届く関数は、ここで落ちる。
//  3. 抜き出した宣言と、地図・座標を JSON で吐くだけの main を一時ディレクトリへ書き、go build して動かす。
//
// **限界（承知のうえで受け入れる）:** 生成物のコードを手元で動かす。動かすのは 2 で抜き出した宣言だけで、
// import は標準ライブラリの計算系に限られるため、ファイル・ネットワーク・環境変数には触れない。それでも
// 無限ループやメモリの食い潰しは防げないので、実行には時間の上限（runTimeout）を掛ける。

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"go/ast"
	"go/parser"
	"go/printer"
	"go/token"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// SkipError は「判定しない」を表す。理由は利用者（運営）が読む文で書く。
type SkipError struct{ Reason string }

func (e *SkipError) Error() string { return e.Reason }

func skipf(format string, args ...any) error {
	return &SkipError{Reason: fmt.Sprintf(format, args...)}
}

// allowedImports は、地図を組み立てるコードがたどってよい import である。
// **計算だけをする標準ライブラリに限る。** 入出力（os / net / fmt）、描画（ebiten）、乱数と時刻
// （math/rand / time。地図が実行ごとに変わる）、unsafe は入れない。
var allowedImports = map[string]bool{
	"math":         true,
	"math/bits":    true,
	"strings":      true,
	"strconv":      true,
	"sort":         true,
	"slices":       true,
	"errors":       true,
	"bytes":        true,
	"unicode":      true,
	"unicode/utf8": true,
	"image/color":  true,
}

// randomImports は、たどった先にあれば「地図を実行時に乱数で作る作品」とみなす import（issue の scope.out）。
var randomImports = map[string]bool{
	"math/rand":    true,
	"math/rand/v2": true,
	"crypto/rand":  true,
	"time":         true,
}

const (
	buildTimeout = 2 * time.Minute
	runTimeout   = 10 * time.Second
)

var (
	// タイルの定数の名前。tileWall / TileDoor / wallTile / cellFloor / Empty など。
	tileConstRe = regexp.MustCompile(`(?i)^(tile|cell|block|t)?_?(wall|door|floor|empty)(tile|cell)?$`)
	// 1 マスの大きさの定数の名前。tileSize / TILE / cellSize / tilePx など。
	tileSizeRe = regexp.MustCompile(`(?i)^(tile|cell)_?(size|px|w|width)?$`)
)

// role は座標の配列の役割である。
type role string

const (
	roleStart role = "start"
	roleKey   role = "key"
	roleDoor  role = "door"
	roleExit  role = "exit"
)

// classifyCoordName は、座標の配列の名前から役割を決める。**2 つ以上に当たる名前は役割無しにする**。
func classifyCoordName(name string) (role, bool) {
	n := strings.ToLower(name)
	var hits []role
	if strings.Contains(n, "start") || strings.Contains(n, "spawn") {
		hits = append(hits, roleStart)
	}
	if strings.Contains(n, "key") {
		hits = append(hits, roleKey)
	}
	if strings.Contains(n, "door") || strings.Contains(n, "gate") {
		hits = append(hits, roleDoor)
	}
	if strings.Contains(n, "exit") || strings.Contains(n, "goal") {
		hits = append(hits, roleExit)
	}
	if len(hits) != 1 {
		return "", false
	}
	return hits[0], true
}

// unit は抜き出しの単位（トップレベルの宣言 1 つ。const のまとまりは iota を保つため丸ごと 1 つ）。
type unit struct {
	decl ast.Decl
	// method のときの受け手の型の名前とメソッド名。
	recvType, method string
}

// analysis は候補を結び付けた結果である。
type analysis struct {
	mapVar  string
	builder string // 空なら、地図の配列の初期化子だけで決まる。"init" は自動で走る

	coords map[role]string // 役割 → 変数名
	order  map[role]string // 役割 → "xy"（[0] が列）か "yx"

	tiles    map[string]string // "wall" / "door" / "floor" → 定数名
	tileSize string            // 画素からマスへ直すときの定数名（スタートを画素で書く作品だけ）

	startExprs [][2]string // スタートの画素の式（x, y）。スタートの座標の配列が無い作品だけ

	names    map[string]*unit
	methods  map[string][]*unit
	inits    []*unit
	imports  map[string]string // 名前 → path
	dotImprt bool
}

// Extracted は、地図を組み立てるコードを動かして得た値である。
type Extracted struct {
	Maps     [][][]int          `json:"maps"`
	Coords   map[string][][]int `json:"coords"`
	Tiles    map[string]int     `json:"tiles"`
	TileSize float64            `json:"tileSize"`
	Starts   [][2]float64       `json:"starts"`
	// 以下は取り出し方の記録（報告用）。
	Names map[string]string `json:"names"`
	Order map[string]string `json:"order"`
}

// Extract は、ソースから地図と座標を取り出す。取り出せない・曖昧なときは *SkipError を返す。
func Extract(ctx context.Context, src []byte) (*Extracted, error) {
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, "source.go", src, 0)
	if err != nil {
		return nil, skipf("Go として読めない: %v", err)
	}
	a, err := analyze(file)
	if err != nil {
		return nil, err
	}
	prog, err := a.program(fset)
	if err != nil {
		return nil, err
	}
	out, err := runProgram(ctx, prog)
	if err != nil {
		return nil, err
	}
	var ex Extracted
	if err := json.Unmarshal(out, &ex); err != nil {
		return nil, skipf("地図を組み立てるコードの出力を読めない: %v", err)
	}
	ex.Names = map[string]string{"map": a.mapVar, "builder": a.builder}
	ex.Order = map[string]string{}
	for r, n := range a.coords {
		ex.Names[string(r)] = n
		ex.Order[string(r)] = a.order[r]
	}
	for k, n := range a.tiles {
		ex.Names["tile."+k] = n
	}
	if a.tileSize != "" {
		ex.Names["tileSize"] = a.tileSize
	}
	return &ex, nil
}

// ── 1. 候補を探して結び付ける ───────────────────────────────────────────────

func analyze(file *ast.File) (*analysis, error) {
	a := &analysis{
		names:   map[string]*unit{},
		methods: map[string][]*unit{},
		imports: map[string]string{},
		coords:  map[role]string{},
		order:   map[role]string{},
		tiles:   map[string]string{},
	}
	a.index(file)
	if a.dotImprt {
		return nil, skipf("ドット import（import . \"…\"）があり、名前の出どころを決められない")
	}

	// 地図の配列: トップレベルの var で、型が [N][rows][cols]int のもの。ちょうど 1 つ。
	var mapVars []string
	var mapHasInit bool
	constNames := map[string]bool{}
	for _, d := range file.Decls {
		g, ok := d.(*ast.GenDecl)
		if !ok {
			continue
		}
		for _, s := range g.Specs {
			vs, ok := s.(*ast.ValueSpec)
			if !ok {
				continue
			}
			for i, n := range vs.Names {
				if g.Tok == token.CONST {
					constNames[n.Name] = true
					continue
				}
				if g.Tok != token.VAR {
					continue
				}
				t := valueSpecType(vs, i)
				switch {
				case isIntArrayOfDepth(t, 3):
					mapVars = append(mapVars, n.Name)
					mapHasInit = i < len(vs.Values)
				case isCoordArray(t):
					r, ok := classifyCoordName(n.Name)
					if !ok {
						continue
					}
					if prev, dup := a.coords[r]; dup {
						return nil, skipf("%s の座標の配列が 2 つある（%s と %s）", roleLabel(r), prev, n.Name)
					}
					a.coords[r] = n.Name
				}
			}
		}
	}
	switch len(mapVars) {
	case 0:
		return nil, skipf("地図の配列（トップレベルの var で型が [面][行][列]int）が無い")
	case 1:
		a.mapVar = mapVars[0]
	default:
		return nil, skipf("地図の配列の候補が 2 つ以上ある（%s）", strings.Join(mapVars, ", "))
	}
	for _, r := range []role{roleKey, roleExit} {
		if _, ok := a.coords[r]; !ok {
			return nil, skipf("%sの座標の配列（トップレベルの var で型が [面][2]int）が無い", roleLabel(r))
		}
	}

	// 地図を組み立てる関数: 引数も戻り値も無い関数で、地図の配列へ書くもの。ちょうど 1 つ。
	var builders []string
	for _, d := range file.Decls {
		fd, ok := d.(*ast.FuncDecl)
		if !ok || fd.Recv != nil || fd.Body == nil || fd.Name.Name == "main" {
			continue
		}
		if fd.Type.Params.NumFields() != 0 || fd.Type.Results.NumFields() != 0 || fd.Type.TypeParams.NumFields() != 0 {
			continue
		}
		if writesVar(fd.Body, a.mapVar) {
			builders = append(builders, fd.Name.Name)
		}
	}
	switch {
	case len(builders) == 1:
		a.builder = builders[0]
	case len(builders) > 1:
		return nil, skipf("地図を組み立てる関数の候補が 2 つ以上ある（%s）", strings.Join(builders, ", "))
	case !mapHasInit:
		return nil, skipf("地図の配列 %s を組み立てる関数（引数と戻り値の無い関数）が見つからない", a.mapVar)
	}

	// タイルの定数。壁は必須、扉と床は任意。
	for name := range constNames {
		m := tileConstRe.FindStringSubmatch(name)
		if m == nil {
			continue
		}
		kind := strings.ToLower(m[2])
		if kind == "empty" {
			kind = "floor"
		}
		if prev, dup := a.tiles[kind]; dup {
			return nil, skipf("タイルの定数（%s）の候補が 2 つある（%s と %s）", kind, prev, name)
		}
		a.tiles[kind] = name
	}
	if _, ok := a.tiles["wall"]; !ok {
		return nil, skipf("壁のタイルの定数（tileWall など）が無い")
	}

	// 座標の並び（[0] が列か行か）を、ソースの使われ方から決める。役割ごとに証拠が要る。
	evidence := collectOrderEvidence(file, a.coords)
	for r, name := range a.coords {
		ev := evidence[name]
		switch {
		case len(ev) == 0:
			return nil, skipf("%s（%s）の [0] が列か行かを、ソースの使われ方から決められない", roleLabel(r), name)
		case len(ev) > 1:
			return nil, skipf("%s（%s）の [0] が列か行か、ソースの中で食い違う", roleLabel(r), name)
		}
		for o := range ev {
			a.order[r] = o
		}
	}

	// スタート: 座標の配列が無ければ、自機の位置（画素）への代入から取る。
	if _, ok := a.coords[roleStart]; !ok {
		pairs := collectStartAssignments(file, constNames)
		if len(pairs) == 0 {
			return nil, skipf("スタートの座標（startPos などの配列、または自機の位置 px/py への定数の代入）が見つからない")
		}
		a.startExprs = pairs
		var sizes []string
		for name := range constNames {
			if tileSizeRe.MatchString(name) {
				sizes = append(sizes, name)
			}
		}
		if len(sizes) != 1 {
			sort.Strings(sizes)
			return nil, skipf("スタートを画素からマスへ直す定数（tileSize など）が 1 つに決まらない（候補: %v）", sizes)
		}
		a.tileSize = sizes[0]
	}
	return a, nil
}

func roleLabel(r role) string {
	switch r {
	case roleStart:
		return "スタート"
	case roleKey:
		return "カギ"
	case roleDoor:
		return "扉"
	case roleExit:
		return "ゴール"
	}
	return string(r)
}

// index はトップレベルの宣言を名前で引けるようにする。
func (a *analysis) index(file *ast.File) {
	for _, im := range file.Imports {
		p, _ := strconv.Unquote(im.Path.Value)
		name := defaultImportName(p)
		if im.Name != nil {
			switch im.Name.Name {
			case ".":
				a.dotImprt = true
				continue
			case "_":
				continue
			}
			name = im.Name.Name
		}
		a.imports[name] = p
	}
	for _, d := range file.Decls {
		switch d := d.(type) {
		case *ast.GenDecl:
			switch d.Tok {
			case token.CONST:
				u := &unit{decl: d}
				for _, s := range d.Specs {
					for _, n := range s.(*ast.ValueSpec).Names {
						a.names[n.Name] = u
					}
				}
			case token.VAR, token.TYPE:
				for _, s := range d.Specs {
					u := &unit{decl: &ast.GenDecl{Tok: d.Tok, Specs: []ast.Spec{s}}}
					switch s := s.(type) {
					case *ast.ValueSpec:
						for _, n := range s.Names {
							a.names[n.Name] = u
						}
					case *ast.TypeSpec:
						a.names[s.Name.Name] = u
					}
				}
			}
		case *ast.FuncDecl:
			u := &unit{decl: d}
			if d.Recv != nil {
				if len(d.Recv.List) == 1 {
					u.recvType, u.method = recvTypeName(d.Recv.List[0].Type), d.Name.Name
					a.methods[u.recvType] = append(a.methods[u.recvType], u)
				}
				continue
			}
			switch d.Name.Name {
			case "main":
				// 元の main は入れない（ゲームループを走らせない）。
			case "init":
				a.inits = append(a.inits, u)
			default:
				a.names[d.Name.Name] = u
			}
		}
	}
}

func defaultImportName(p string) string {
	parts := strings.Split(p, "/")
	last := parts[len(parts)-1]
	if len(parts) > 1 && regexp.MustCompile(`^v[0-9]+$`).MatchString(last) {
		last = parts[len(parts)-2]
	}
	return last
}

func recvTypeName(e ast.Expr) string {
	switch t := e.(type) {
	case *ast.StarExpr:
		return recvTypeName(t.X)
	case *ast.IndexExpr:
		return recvTypeName(t.X)
	case *ast.IndexListExpr:
		return recvTypeName(t.X)
	case *ast.Ident:
		return t.Name
	}
	return ""
}

func valueSpecType(vs *ast.ValueSpec, i int) ast.Expr {
	if vs.Type != nil {
		return vs.Type
	}
	if i < len(vs.Values) {
		if cl, ok := vs.Values[i].(*ast.CompositeLit); ok {
			return cl.Type
		}
	}
	return nil
}

// isIntArrayOfDepth は、型が長さ付きの配列を depth 段重ねた int か。
func isIntArrayOfDepth(t ast.Expr, depth int) bool {
	for i := 0; i < depth; i++ {
		at, ok := t.(*ast.ArrayType)
		if !ok || at.Len == nil {
			return false
		}
		t = at.Elt
	}
	id, ok := t.(*ast.Ident)
	return ok && id.Name == "int"
}

// isCoordArray は、型が [N][2]int か。
func isCoordArray(t ast.Expr) bool {
	if !isIntArrayOfDepth(t, 2) {
		return false
	}
	inner := t.(*ast.ArrayType).Elt.(*ast.ArrayType)
	lit, ok := inner.Len.(*ast.BasicLit)
	return ok && lit.Kind == token.INT && lit.Value == "2"
}

// rootIdent は、a[i][j].f のような式の根の名前を返す。
func rootIdent(e ast.Expr) string {
	for {
		switch x := e.(type) {
		case *ast.Ident:
			return x.Name
		case *ast.IndexExpr:
			e = x.X
		case *ast.SelectorExpr:
			e = x.X
		case *ast.ParenExpr:
			e = x.X
		case *ast.StarExpr:
			e = x.X
		default:
			return ""
		}
	}
}

// writesVar は、本体が変数 name へ書くか（代入・++/--・&name[…] で補助関数へ渡す）。
func writesVar(body *ast.BlockStmt, name string) bool {
	found := false
	ast.Inspect(body, func(n ast.Node) bool {
		switch x := n.(type) {
		case *ast.AssignStmt:
			for _, l := range x.Lhs {
				if rootIdent(l) == name {
					found = true
				}
			}
		case *ast.IncDecStmt:
			if rootIdent(x.X) == name {
				found = true
			}
		case *ast.UnaryExpr:
			if x.Op == token.AND && rootIdent(x.X) == name {
				found = true
			}
		}
		return !found
	})
	return found
}

// coordRef は、式が C[…][0] か C[…][1]（C は座標の配列）かを返す。
func coordRef(e ast.Expr, coordVars map[string]bool) (string, int, bool) {
	outer, ok := e.(*ast.IndexExpr)
	if !ok {
		return "", 0, false
	}
	lit, ok := outer.Index.(*ast.BasicLit)
	if !ok || lit.Kind != token.INT || (lit.Value != "0" && lit.Value != "1") {
		return "", 0, false
	}
	inner, ok := outer.X.(*ast.IndexExpr)
	if !ok {
		return "", 0, false
	}
	id, ok := inner.X.(*ast.Ident)
	if !ok || !coordVars[id.Name] {
		return "", 0, false
	}
	k, _ := strconv.Atoi(lit.Value)
	return id.Name, k, true
}

func flattenIndex(e ast.Expr) []ast.Expr {
	var idx []ast.Expr
	for {
		ie, ok := e.(*ast.IndexExpr)
		if !ok {
			break
		}
		idx = append([]ast.Expr{ie.Index}, idx...)
		e = ie.X
	}
	return idx
}

// axisOfName は、変数名から軸を読む（x / kx / keyX → "x"）。読めなければ空。
func axisOfName(n string) string {
	switch {
	case n == "x" || n == "X":
		return "x"
	case n == "y" || n == "Y":
		return "y"
	case len(n) == 2 && n[1] == 'x':
		return "x"
	case len(n) == 2 && n[1] == 'y':
		return "y"
	case len(n) > 2 && strings.HasSuffix(n, "X") && n[len(n)-2] >= 'a' && n[len(n)-2] <= 'z':
		return "x"
	case len(n) > 2 && strings.HasSuffix(n, "Y") && n[len(n)-2] >= 'a' && n[len(n)-2] <= 'z':
		return "y"
	}
	return ""
}

func nameOf(e ast.Expr) string {
	switch x := e.(type) {
	case *ast.Ident:
		return x.Name
	case *ast.SelectorExpr:
		return x.Sel.Name
	}
	return ""
}

// collectOrderEvidence は、座標の配列ごとに「[0] が列（xy）か行（yx）か」の証拠を集める。
//
//   - 2 次元の添字 m[C[i][a]][C[i][b]] では、行（手前の添字）に使われたほうが y である
//   - kx := C[i][0]*tileSize… のように、x / y を名乗る変数へ 1 成分だけを入れていれば、その成分がその軸である
func collectOrderEvidence(file *ast.File, coords map[role]string) map[string]map[string]bool {
	vars := map[string]bool{}
	for _, n := range coords {
		vars[n] = true
	}
	ev := map[string]map[string]bool{}
	add := func(name string, xComponent int) {
		if ev[name] == nil {
			ev[name] = map[string]bool{}
		}
		if xComponent == 0 {
			ev[name]["xy"] = true
		} else {
			ev[name]["yx"] = true
		}
	}
	singleRef := func(e ast.Expr) (string, int, bool) {
		type ref struct {
			name string
			k    int
		}
		seen := map[ref]bool{}
		ast.Inspect(e, func(n ast.Node) bool {
			if ex, ok := n.(ast.Expr); ok {
				if name, k, ok := coordRef(ex, vars); ok {
					seen[ref{name, k}] = true
					return false
				}
			}
			return true
		})
		if len(seen) != 1 {
			return "", 0, false
		}
		for r := range seen {
			return r.name, r.k, true
		}
		return "", 0, false
	}
	byAxis := func(lhs, rhs ast.Expr) {
		axis := axisOfName(nameOf(lhs))
		if axis == "" {
			return
		}
		name, k, ok := singleRef(rhs)
		if !ok {
			return
		}
		if axis == "x" {
			add(name, k)
		} else {
			add(name, 1-k)
		}
	}
	ast.Inspect(file, func(n ast.Node) bool {
		switch x := n.(type) {
		case *ast.IndexExpr:
			idx := flattenIndex(x)
			if len(idx) >= 2 {
				rn, rk, ok1 := coordRef(idx[len(idx)-2], vars)
				cn, ck, ok2 := coordRef(idx[len(idx)-1], vars)
				if ok1 && ok2 && rn == cn && rk != ck {
					// 行に使われた成分 rk が y。
					add(rn, 1-rk)
				}
			}
		case *ast.AssignStmt:
			if len(x.Lhs) == len(x.Rhs) {
				for i := range x.Lhs {
					byAxis(x.Lhs[i], x.Rhs[i])
				}
			}
		case *ast.ValueSpec:
			if len(x.Names) == len(x.Values) {
				for i := range x.Names {
					byAxis(x.Names[i], x.Values[i])
				}
			}
		}
		return true
	})
	return ev
}

// playerAxis は、代入の左辺が自機の位置（画素）なら軸を返す。
func playerAxis(e ast.Expr) string {
	sel, ok := e.(*ast.SelectorExpr)
	if !ok {
		return ""
	}
	switch sel.Sel.Name {
	case "px", "playerX", "plX", "heroX":
		return "x"
	case "py", "playerY", "plY", "heroY":
		return "y"
	case "x", "X", "y", "Y":
		parent := strings.ToLower(nameOf(sel.X))
		if parent == "player" || parent == "hero" {
			return strings.ToLower(sel.Sel.Name)
		}
	}
	return ""
}

// isConstExpr は、式が定数とリテラルと数値の型変換だけでできているか。
func isConstExpr(e ast.Expr, consts map[string]bool) bool {
	ok := true
	ast.Inspect(e, func(n ast.Node) bool {
		if !ok {
			return false
		}
		switch x := n.(type) {
		case nil:
			return false
		case *ast.BasicLit, *ast.BinaryExpr, *ast.ParenExpr, *ast.UnaryExpr:
			return true
		case *ast.CallExpr:
			id, isID := x.Fun.(*ast.Ident)
			if !isID || len(x.Args) != 1 {
				ok = false
				return false
			}
			switch id.Name {
			case "float64", "float32", "int", "int32", "int64":
			default:
				ok = false
				return false
			}
			ok = isConstExpr(x.Args[0], consts)
			return false
		case *ast.Ident:
			if !consts[x.Name] {
				ok = false
			}
			return false
		default:
			ok = false
			return false
		}
	})
	return ok
}

// collectStartAssignments は、自機の位置（画素）へ定数の式を代入している箇所を (x, y) の組で集める。
// 同じブロックの中で x の代入のあとに y の代入が来る組と、g.px, g.py = a, b の形を拾う。
func collectStartAssignments(file *ast.File, consts map[string]bool) [][2]string {
	seen := map[[2]string]bool{}
	var pairs [][2]string
	str := func(e ast.Expr) string {
		var b bytes.Buffer
		_ = printer.Fprint(&b, token.NewFileSet(), e)
		return b.String()
	}
	push := func(x, y ast.Expr) {
		if !isConstExpr(x, consts) || !isConstExpr(y, consts) {
			return
		}
		p := [2]string{str(x), str(y)}
		if !seen[p] {
			seen[p] = true
			pairs = append(pairs, p)
		}
	}
	ast.Inspect(file, func(n ast.Node) bool {
		block, ok := n.(*ast.BlockStmt)
		if !ok {
			return true
		}
		var pendingX ast.Expr
		for _, st := range block.List {
			as, ok := st.(*ast.AssignStmt)
			if !ok || as.Tok != token.ASSIGN || len(as.Lhs) != len(as.Rhs) {
				continue
			}
			if len(as.Lhs) == 2 && playerAxis(as.Lhs[0]) == "x" && playerAxis(as.Lhs[1]) == "y" {
				push(as.Rhs[0], as.Rhs[1])
				continue
			}
			for i, l := range as.Lhs {
				switch playerAxis(l) {
				case "x":
					pendingX = as.Rhs[i]
				case "y":
					if pendingX != nil {
						push(pendingX, as.Rhs[i])
						pendingX = nil
					}
				}
			}
		}
		return true
	})
	return pairs
}

// ── 2. 要る宣言だけを抜き出す ────────────────────────────────────────────────

// closure は seeds から参照をたどり、要る宣言と import の path を返す。
func (a *analysis) closure(seeds []string) ([]*unit, []string, error) {
	included := map[*unit]bool{}
	var order []*unit
	usedImports := map[string]bool{}
	selNames := map[string]bool{}
	var queue []*unit
	add := func(u *unit) {
		if u != nil && !included[u] {
			included[u] = true
			order = append(order, u)
			queue = append(queue, u)
		}
	}
	for _, s := range seeds {
		if u, ok := a.names[s]; ok {
			add(u)
		}
	}
	if a.builder == "init" {
		for _, u := range a.inits {
			add(u)
		}
	}
	var visit func(n ast.Node) bool
	visit = func(n ast.Node) bool {
		switch x := n.(type) {
		case *ast.SelectorExpr:
			selNames[x.Sel.Name] = true
			if id, ok := x.X.(*ast.Ident); ok {
				if u, top := a.names[id.Name]; top {
					add(u)
				} else if _, imp := a.imports[id.Name]; imp {
					usedImports[id.Name] = true
				}
				return false
			}
			ast.Inspect(x.X, visit)
			return false
		case *ast.Ident:
			if u, ok := a.names[x.Name]; ok {
				add(u)
			}
		}
		return true
	}
	for {
		for len(queue) > 0 {
			u := queue[0]
			queue = queue[1:]
			ast.Inspect(u.decl, visit)
		}
		// 抜き出した型のメソッドのうち、呼ばれうる名前（セレクタに現れた名前）のものだけ足す。
		grew := false
		for typeName, ms := range a.methods {
			tu, ok := a.names[typeName]
			if !ok || !included[tu] {
				continue
			}
			for _, m := range ms {
				if selNames[m.method] && !included[m] {
					add(m)
					grew = true
				}
			}
		}
		if !grew {
			break
		}
	}
	var paths []string
	var random, denied []string
	for name := range usedImports {
		p := a.imports[name]
		switch {
		case randomImports[p]:
			random = append(random, p)
		case !allowedImports[p]:
			denied = append(denied, p)
		default:
			paths = append(paths, p)
		}
	}
	sort.Strings(random)
	sort.Strings(denied)
	sort.Strings(paths)
	if len(random) > 0 {
		return nil, nil, skipf("地図を組み立てるコードが乱数・時刻（%s）に届く（地図が実行ごとに変わりうる）", strings.Join(random, ", "))
	}
	if len(denied) > 0 {
		return nil, nil, skipf("地図を組み立てるコードが許可していない import（%s）に届く", strings.Join(denied, ", "))
	}
	return order, paths, nil
}

// program は、抜き出した宣言と、値を JSON で吐く main の 2 ファイルを返す。
func (a *analysis) program(fset *token.FileSet) (map[string]string, error) {
	seeds := []string{a.mapVar}
	if a.builder != "" && a.builder != "init" {
		seeds = append(seeds, a.builder)
	}
	for _, n := range a.coords {
		seeds = append(seeds, n)
	}
	for _, n := range a.tiles {
		seeds = append(seeds, n)
	}
	if a.tileSize != "" {
		seeds = append(seeds, a.tileSize)
	}
	units, imports, err := a.closure(seeds)
	if err != nil {
		return nil, err
	}
	// スタートの式が参照する定数も足す（定数だけなので import は増えない）。
	for _, p := range a.startExprs {
		for _, e := range p {
			for _, id := range regexp.MustCompile(`[A-Za-z_][A-Za-z0-9_]*`).FindAllString(e, -1) {
				if u, ok := a.names[id]; ok {
					if _, isGen := u.decl.(*ast.GenDecl); isGen && !containsUnit(units, u) {
						units = append(units, u)
					}
				}
			}
		}
	}

	var src bytes.Buffer
	src.WriteString("package main\n\n")
	for _, p := range imports {
		fmt.Fprintf(&src, "import %q\n", p)
	}
	src.WriteString("\n")
	for _, u := range units {
		if err := printer.Fprint(&src, fset, u.decl); err != nil {
			return nil, skipf("抜き出した宣言を書き出せない: %v", err)
		}
		src.WriteString("\n\n")
	}

	var h bytes.Buffer
	h.WriteString("package main\n\nimport (\n\ttrJSON \"encoding/json\"\n\ttrOS \"os\"\n)\n\n")
	h.WriteString("func main() {\n")
	if a.builder != "" && a.builder != "init" {
		fmt.Fprintf(&h, "\t%s()\n", a.builder)
	}
	h.WriteString("\ttrOut := map[string]any{}\n")
	fmt.Fprintf(&h, "\ttrOut[\"maps\"] = %s\n", a.mapVar)
	h.WriteString("\ttrCoords := map[string]any{}\n")
	for _, r := range sortedRoles(a.coords) {
		fmt.Fprintf(&h, "\ttrCoords[%q] = %s\n", string(r), a.coords[r])
	}
	h.WriteString("\ttrOut[\"coords\"] = trCoords\n")
	h.WriteString("\ttrTiles := map[string]int{}\n")
	for _, k := range sortedKeys(a.tiles) {
		fmt.Fprintf(&h, "\ttrTiles[%q] = int(%s)\n", k, a.tiles[k])
	}
	h.WriteString("\ttrOut[\"tiles\"] = trTiles\n")
	if a.tileSize != "" {
		fmt.Fprintf(&h, "\ttrOut[\"tileSize\"] = float64(%s)\n", a.tileSize)
	}
	h.WriteString("\ttrStarts := [][2]float64{}\n")
	for _, p := range a.startExprs {
		fmt.Fprintf(&h, "\ttrStarts = append(trStarts, [2]float64{float64(%s), float64(%s)})\n", p[0], p[1])
	}
	h.WriteString("\ttrOut[\"starts\"] = trStarts\n")
	h.WriteString("\tif err := trJSON.NewEncoder(trOS.Stdout).Encode(trOut); err != nil {\n\t\ttrOS.Exit(1)\n\t}\n}\n")

	return map[string]string{
		"extracted.go":  src.String(),
		"zz_harness.go": h.String(),
	}, nil
}

func containsUnit(us []*unit, u *unit) bool {
	for _, x := range us {
		if x == u {
			return true
		}
	}
	return false
}

func sortedRoles(m map[role]string) []role {
	var rs []role
	for r := range m {
		rs = append(rs, r)
	}
	sort.Slice(rs, func(i, j int) bool { return rs[i] < rs[j] })
	return rs
}

func sortedKeys(m map[string]string) []string {
	var ks []string
	for k := range m {
		ks = append(ks, k)
	}
	sort.Strings(ks)
	return ks
}

// ── 3. 動かす ───────────────────────────────────────────────────────────────

// runProgram は、一時ディレクトリで go build し、できたものを時間の上限つきで動かして標準出力を返す。
//
// ビルドはモジュールを取りに行かない（GOPROXY=off / GOFLAGS=-mod=mod を付けない / 依存が無い）。
// 動かすときは環境変数を渡さない。
func runProgram(ctx context.Context, files map[string]string) ([]byte, error) {
	dir, err := os.MkdirTemp("", "tile-reachability-*")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(dir)

	goVersion, err := localGoVersion(ctx)
	if err != nil {
		return nil, err
	}
	files["go.mod"] = "module tilereach\n\ngo " + goVersion + "\n"
	for name, body := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o600); err != nil {
			return nil, err
		}
	}

	bctx, cancel := context.WithTimeout(ctx, buildTimeout)
	defer cancel()
	bin := filepath.Join(dir, "harness")
	build := exec.CommandContext(bctx, "go", "build", "-o", bin, ".")
	build.Dir = dir
	build.Env = append(os.Environ(), "GOPROXY=off", "GOTOOLCHAIN=local", "GOWORK=off", "GOFLAGS=", "CGO_ENABLED=0")
	if out, err := build.CombinedOutput(); err != nil {
		msg := strings.TrimSpace(string(out))
		if len(msg) > 600 {
			msg = msg[:600] + "…"
		}
		return nil, skipf("抜き出した地図のコードをビルドできない（%s）", msg)
	}

	rctx, rcancel := context.WithTimeout(ctx, runTimeout)
	defer rcancel()
	run := exec.CommandContext(rctx, bin)
	run.Dir = dir
	run.Env = []string{}
	var stdout, stderr bytes.Buffer
	run.Stdout = &stdout
	run.Stderr = &stderr
	if err := run.Run(); err != nil {
		if errors.Is(rctx.Err(), context.DeadlineExceeded) {
			return nil, skipf("地図を組み立てるコードが %s で終わらない", runTimeout)
		}
		msg := strings.TrimSpace(stderr.String())
		if len(msg) > 600 {
			msg = msg[:600] + "…"
		}
		return nil, skipf("地図を組み立てるコードが異常終了した（%s）", msg)
	}
	return stdout.Bytes(), nil
}

// localGoVersion は手元の Go の版を "1.26" の形で返す（抜き出したコードの言語の版に使う）。
func localGoVersion(ctx context.Context) (string, error) {
	out, err := exec.CommandContext(ctx, "go", "env", "GOVERSION").Output()
	if err != nil {
		return "", fmt.Errorf("go env GOVERSION を読めない: %w", err)
	}
	m := regexp.MustCompile(`^go(\d+)\.(\d+)`).FindStringSubmatch(strings.TrimSpace(string(out)))
	if m == nil {
		return "", fmt.Errorf("go の版を読めない: %q", out)
	}
	return m[1] + "." + m[2], nil
}
