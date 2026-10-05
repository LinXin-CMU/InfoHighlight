using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal sealed class FloatingController : Form {
    readonly Action<string> execute;
    readonly Action<string> setMode;
    readonly Label status=new Label(),handle=new Label();
    readonly Button pause=new Button(),expand=new Button();
    readonly ComboBox mode=new ComboBox();
    readonly string prefs=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"InfoLens","floating-controller.json");
    readonly JavaScriptSerializer json=new JavaScriptSerializer();
    bool expanded,paused,reflecting,dragging;Point dragOrigin,windowOrigin;
    public bool EnabledByUser {get;private set;}
    public bool NativeVisible {get{return IsHandleCreated&&IsWindowVisible(Handle);}}
    public bool HideInFullscreen {get;private set;}
    public void ToggleFullscreenPolicy(){HideInFullscreen=!HideInFullscreen;Save();}
    protected override bool ShowWithoutActivation {get{return true;}}
    public FloatingController(Action<string> action,Action<string> changeMode){
        execute=action;setMode=changeMode;AutoScaleMode=AutoScaleMode.Dpi;Font=new Font("Microsoft YaHei UI",9);Text="InfoLens 悬浮控制器";FormBorderStyle=FormBorderStyle.None;ShowInTaskbar=false;TopMost=true;BackColor=Color.FromArgb(38,38,38);ForeColor=Color.White;
        handle.Text="◉";handle.ForeColor=Color.FromArgb(255,91,82);handle.Font=new Font("Segoe UI",21);handle.SetBounds(3,0,40,44);handle.TextAlign=ContentAlignment.MiddleCenter;Controls.Add(handle);
        expand.Text="›";expand.SetBounds(43,5,25,32);expand.FlatStyle=FlatStyle.Flat;expand.Click+=(s,e)=>{expanded=!expanded;LayoutControls();};Controls.Add(expand);
        status.SetBounds(12,53,256,45);status.Text="正在连接本机服务…";Controls.Add(status);
        mode.DropDownStyle=ComboBoxStyle.DropDownList;mode.Items.AddRange(new object[]{"统一信号：融合","统一信号：信息密度","统一信号：语义重要度"});mode.SetBounds(12,106,256,28);mode.SelectedIndex=0;mode.SelectedIndexChanged+=(s,e)=>{if(!reflecting)setMode(new[]{"hybrid","information_density","semantic_importance"}[mode.SelectedIndex]);};Controls.Add(mode);
        pause.Text="暂停新分析";pause.SetBounds(12,145,120,32);pause.Click+=(s,e)=>execute(paused?"resume":"pause");Controls.Add(pause);
        var open=new Button{Text="阅读工作台"};open.SetBounds(142,145,126,32);open.Click+=(s,e)=>execute("open");Controls.Add(open);
        handle.MouseDown+=(s,e)=>{if(e.Button==MouseButtons.Left){dragging=true;dragOrigin=Cursor.Position;windowOrigin=Location;handle.Capture=true;}};
        handle.MouseMove+=(s,e)=>{if(dragging){var p=Cursor.Position;Location=new Point(windowOrigin.X+p.X-dragOrigin.X,windowOrigin.Y+p.Y-dragOrigin.Y);}};
        handle.MouseUp+=(s,e)=>{dragging=false;handle.Capture=false;Save();};
        Location=new Point(Screen.PrimaryScreen.WorkingArea.Right-95,Screen.PrimaryScreen.WorkingArea.Bottom-100);
        try{var p=json.Deserialize<Dictionary<string,object>>(File.ReadAllText(prefs));EnabledByUser=p.ContainsKey("enabled")&&p["enabled"] is bool&&(bool)p["enabled"];HideInFullscreen=p.ContainsKey("autoHideFullscreen")&&p["autoHideFullscreen"] is bool&&(bool)p["autoHideFullscreen"];Location=new Point(Convert.ToInt32(p["x"]),Convert.ToInt32(p["y"]));}catch{}
        LayoutControls();if(EnabledByUser)Display();
    }
    void LayoutControls(){Size=new Size(expanded?280:72,expanded?190:44);expand.Text=expanded?"‹":"›";status.Visible=mode.Visible=pause.Visible=expanded;foreach(Control c in Controls)if(c is Button&&c!=expand&&c!=pause)c.Visible=expanded;Clamp();}
    void Clamp(){var bounds=Screen.FromPoint(Location).WorkingArea;Location=new Point(Math.Max(bounds.Left,Math.Min(Left,bounds.Right-Width)),Math.Max(bounds.Top,Math.Min(Top,bounds.Bottom-Height)));}
    void Save(){try{Directory.CreateDirectory(Path.GetDirectoryName(prefs));var temp=prefs+".tmp";File.WriteAllText(temp,json.Serialize(new {enabled=EnabledByUser,x=Left,y=Top,autoHideFullscreen=HideInFullscreen}));if(File.Exists(prefs))File.Replace(temp,prefs,null);else File.Move(temp,prefs);}catch{}}
    void Display(){Clamp();Show();ShowWindow(Handle,4);}
    public void Toggle(){EnabledByUser=!EnabledByUser;if(EnabledByUser)Display();else Hide();Save();}
    public void Reflect(string text,Dictionary<string,object> service,string readingMode){
        status.Text=text;paused=service!=null&&service.ContainsKey("paused")&&service["paused"] is bool&&(bool)service["paused"];pause.Text=paused?"恢复新分析":"暂停新分析";
        if(service!=null&&service.ContainsKey("gpu")&&service["gpu"] is Dictionary<string,object>){var gpu=(Dictionary<string,object>)service["gpu"];if(gpu.ContainsKey("peakAllocatedMiB"))status.Text+="\nPyTorch 峰值 "+gpu["peakAllocatedMiB"]+" MiB";}
        reflecting=true;mode.SelectedIndex=readingMode=="information_density"?1:readingMode=="semantic_importance"?2:0;reflecting=false;
        if(EnabledByUser){if(HideInFullscreen&&FullscreenForeground())Hide();else if(!Visible||!IsWindowVisible(Handle))Display();}
    }
    [StructLayout(LayoutKind.Sequential)] struct Rect {public int Left,Top,Right,Bottom;}
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h,out Rect r);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h,int command);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    bool FullscreenForeground(){var h=GetForegroundWindow();if(h==Handle||h==IntPtr.Zero)return false;Rect r;if(!GetWindowRect(h,out r))return false;var screen=Screen.FromHandle(h).Bounds;return r.Left<=screen.Left&&r.Top<=screen.Top&&r.Right>=screen.Right&&r.Bottom>=screen.Bottom;}
}
