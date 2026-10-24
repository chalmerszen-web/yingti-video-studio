param([Parameter(Mandatory=$true)][string]$Output)
Add-Type -AssemblyName System.Drawing
$images = @()
foreach ($size in @(16,32,48,64,128,256)) {
    $bitmap = [Drawing.Bitmap]::new($size,$size)
    $g = [Drawing.Graphics]::FromImage($bitmap)
    $g.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.ScaleTransform($size/48.0,$size/48.0)
    $shape = [Drawing.Drawing2D.GraphicsPath]::new()
    $shape.AddArc(0,0,28,28,180,90); $shape.AddArc(20,0,28,28,270,90); $shape.AddArc(20,20,28,28,0,90); $shape.AddArc(0,20,28,28,90,90); $shape.CloseFigure()
    $orange = [Drawing.SolidBrush]::new([Drawing.ColorTranslator]::FromHtml('#ef885d'))
    $ink = [Drawing.SolidBrush]::new([Drawing.ColorTranslator]::FromHtml('#1e2428'))
    $cream = [Drawing.SolidBrush]::new([Drawing.ColorTranslator]::FromHtml('#fff4e9'))
    $g.FillPath($orange,$shape); $g.FillRectangle($ink,12,13,8,22); $g.FillRectangle($ink,28,13,8,22)
    $g.FillPolygon($cream,[Drawing.PointF[]]@([Drawing.PointF]::new(19,17),[Drawing.PointF]::new(30,24),[Drawing.PointF]::new(19,31)))
    $memory = [IO.MemoryStream]::new(); $bitmap.Save($memory,[Drawing.Imaging.ImageFormat]::Png)
    $images += @{size=$size;bytes=$memory.ToArray()}
    $memory.Dispose(); $g.Dispose(); $bitmap.Dispose(); $shape.Dispose(); $orange.Dispose(); $ink.Dispose(); $cream.Dispose()
}
$stream = [IO.File]::Create($Output); $writer = [IO.BinaryWriter]::new($stream)
try {
    $writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]$images.Count)
    $offset=6+16*$images.Count
    foreach ($item in $images) {
        $dimension=if($item.size -eq 256){0}else{$item.size}
        $writer.Write([byte]$dimension); $writer.Write([byte]$dimension); $writer.Write([byte]0); $writer.Write([byte]0)
        $writer.Write([uint16]1); $writer.Write([uint16]32); $writer.Write([uint32]$item.bytes.Length); $writer.Write([uint32]$offset)
        $offset += $item.bytes.Length
    }
    foreach($item in $images){$writer.Write([byte[]]$item.bytes)}
} finally { $writer.Dispose(); $stream.Dispose() }
